package cp

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Keepalive: probe the connection between (and through) Cloudflare's idle
// timeouts. The edge closes WebSockets idle > 100s (Free/Pro), so the interval
// is clamped below that even if misconfigured. A missed pong is detected at
// the next tick.
const maxPingInterval = 90 * time.Second

// Reconnect backoff while in ws mode (fallback probes use a fixed interval).
const (
	reconnectBase = 1 * time.Second
	reconnectMax  = 60 * time.Second
)

// >= failureThreshold connection failures within failureWindow => poll fallback.
const (
	failureWindow    = 60 * time.Second
	failureThreshold = 3
)

type ChannelMode string

const (
	ModeWS   ChannelMode = "ws"
	ModePoll ChannelMode = "poll"
)

type WsChannelOptions struct {
	URL       string
	NodeToken string
	// Interval between reconnect probes while in poll fallback.
	ProbeInterval time.Duration
	// Heartbeat interval; the server auto-responds without waking its Durable Object.
	PingInterval time.Duration
}

type WsChannelEvents struct {
	// A config_changed push arrived; the client should fetch the new config now.
	OnConfigChanged func()
	// Entered poll fallback after repeated WebSocket failures.
	OnFallback func()
	// WebSocket reconnected after a fallback period.
	OnRecovered func()
	// Every successful connection (first connect and every reconnect). Fired
	// because a config change broadcast while the channel was down is lost —
	// the DO only pushes to live sockets — so an immediate poll closes the
	// gap instead of waiting out the safety-net interval.
	OnConnected func()
	// Manual rule restart directive: rebuild this one service from the last
	// applied config, dropping its live connections.
	OnRestartService func(service string)
}

// WsChannel is the config-push channel over a WebSocket to the control plane
// (GET /api/agent/ws). Only the failure tracker and the poll-fallback policy
// live here; fetching/applying configs stays in the control loop, triggered
// via OnConfigChanged.
//
// Failure policy: 3 failures within a 60s sliding window demote the channel
// to poll mode. While demoted, one probe attempt runs every ProbeInterval; a
// successful handshake promotes the channel back to ws mode.
type WsChannel struct {
	opts   WsChannelOptions
	events WsChannelEvents
	log    *slog.Logger

	pingInterval time.Duration

	mu               sync.Mutex
	mode             ChannelMode
	connected        bool
	stopped          bool
	reconnectAttempt int
	failures         []time.Time
	pongOutstanding  bool

	cancelConnect context.CancelFunc // cancels the current connect attempt

	wsConn *websocket.Conn

	pingTimer      *time.Timer
	reconnectTimer *time.Timer
}

func NewWsChannel(opts WsChannelOptions, events WsChannelEvents, log *slog.Logger) *WsChannel {
	ping := opts.PingInterval
	if ping > maxPingInterval {
		ping = maxPingInterval
	}
	return &WsChannel{
		opts:         opts,
		events:       events,
		log:          log,
		pingInterval: ping,
		mode:         ModeWS,
		stopped:      true,
	}
}

// Mode reports the current channel mode.
func (c *WsChannel) Mode() ChannelMode {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.mode
}

// PreferWS reports whether the WebSocket is connected and the poll loop can idle.
func (c *WsChannel) PreferWS() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.mode == ModeWS && c.connected
}

func (c *WsChannel) Start() {
	c.mu.Lock()
	if !c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = false
	c.mu.Unlock()

	c.log.Info("Starting config push channel", "url", c.opts.URL)
	go c.connect()
}

func (c *WsChannel) Stop() {
	c.mu.Lock()
	c.stopped = true
	c.clearTimersLocked()
	conn := c.wsConn
	c.wsConn = nil
	cancel := c.cancelConnect
	c.cancelConnect = nil
	c.connected = false
	c.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if conn != nil {
		conn.WriteControl(websocket.CloseMessage, //nolint:errcheck
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "agent shutdown"),
			time.Now().Add(time.Second))
		conn.Close() //nolint:errcheck
	}
	c.log.Info("Config push channel stopped")
}

func (c *WsChannel) connect() {
	ctx, cancel := context.WithCancel(context.Background())
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		cancel()
		return
	}
	c.cancelConnect = cancel
	c.pongOutstanding = false
	c.mu.Unlock()

	header := http.Header{"Authorization": []string{"Bearer " + c.opts.NodeToken}}
	dialer := &websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.DialContext(ctx, c.opts.URL, header)

	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		cancel()
		if conn != nil {
			conn.Close() //nolint:errcheck
		}
		return
	}
	if err != nil {
		c.cancelConnect = nil
		c.mu.Unlock()
		cancel()
		c.onEnded("dial: " + err.Error())
		return
	}
	c.wsConn = conn
	c.cancelConnect = nil
	c.connected = true
	c.reconnectAttempt = 0
	c.startHeartbeatLocked()
	recovered := c.mode == ModePoll
	if recovered {
		c.mode = ModeWS
		c.failures = nil
	}
	c.mu.Unlock()
	cancel()

	if recovered {
		c.log.Info("Config push channel recovered, resuming ws mode")
		if c.events.OnRecovered != nil {
			c.events.OnRecovered()
		}
	} else {
		c.log.Info("Config push channel connected")
	}
	// Any (re)connection may have missed pushes while disconnected — the
	// server broadcasts to live sockets only — so always trigger a poll.
	if c.events.OnConnected != nil {
		c.events.OnConnected()
	}

	c.readLoop(conn)
}

// readLoop pumps messages until the connection ends, then records the failure
// (if any) and schedules a reconnect.
func (c *WsChannel) readLoop(conn *websocket.Conn) {
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			c.onEnded("read: " + err.Error())
			return
		}
		c.handleMessage(string(data))
	}
}

func (c *WsChannel) handleMessage(data string) {
	if data == "pong" {
		c.mu.Lock()
		c.pongOutstanding = false
		c.mu.Unlock()
		return
	}
	if c.isStopped() {
		return
	}
	var parsed struct {
		Type    string `json:"type"`
		Service string `json:"service"`
	}
	if err := json.Unmarshal([]byte(data), &parsed); err != nil {
		return
	}
	switch parsed.Type {
	case "config_changed":
		c.log.Debug("Config change push received")
		if c.events.OnConfigChanged != nil {
			c.events.OnConfigChanged()
		}
	case "restart_service":
		if parsed.Service != "" {
			c.log.Info("Restart directive received", "service", parsed.Service)
			if c.events.OnRestartService != nil {
				c.events.OnRestartService(parsed.Service)
			}
		}
	}
}

// onEnded records a connection failure and schedules the next connect.
func (c *WsChannel) onEnded(reason string) {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.connected = false
	c.clearTimersLocked()

	now := time.Now()
	c.failures = append(c.failures, now)
	kept := c.failures[:0]
	for _, t := range c.failures {
		if now.Sub(t) < failureWindow {
			kept = append(kept, t)
		}
	}
	c.failures = kept
	c.log.Warn("Config push channel connection lost",
		"reason", reason, "failuresInWindow", len(c.failures), "mode", string(c.mode))

	fallback := false
	if c.mode == ModeWS && len(c.failures) >= failureThreshold {
		c.mode = ModePoll
		c.failures = nil
		fallback = true
	}

	delay := c.nextReconnectDelayLocked()
	c.reconnectTimer = time.AfterFunc(delay, func() { go c.connect() })
	c.mu.Unlock()

	if fallback {
		c.log.Warn("Config push channel flapping, falling back to http polling",
			"probeIn", c.opts.ProbeInterval.String())
		if c.events.OnFallback != nil {
			c.events.OnFallback()
		}
		return
	}
	c.log.Info("Reconnecting config push channel", "delay", delay.String())
}

func (c *WsChannel) isStopped() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stopped
}

func (c *WsChannel) nextReconnectDelayLocked() time.Duration {
	if c.mode == ModePoll {
		// Demoted: single probe per interval, no exponential growth.
		return c.opts.ProbeInterval
	}
	attempt := c.reconnectAttempt
	if attempt > 6 {
		attempt = 6 // 1s<<6 = 64s already exceeds the cap; avoid shifting forever
	}
	delay := reconnectBase << attempt
	if delay > reconnectMax {
		delay = reconnectMax
	}
	c.reconnectAttempt++
	return delay
}

func (c *WsChannel) startHeartbeatLocked() {
	c.pingTimer = time.AfterFunc(c.pingInterval, c.pingTick)
}

func (c *WsChannel) pingTick() {
	c.mu.Lock()
	if c.stopped || c.wsConn == nil {
		c.mu.Unlock()
		return
	}
	if c.pongOutstanding {
		c.mu.Unlock()
		c.log.Warn("Pong timeout on config push channel, closing connection")
		c.wsConn.WriteControl(websocket.CloseMessage, //nolint:errcheck
			websocket.FormatCloseMessage(4000, "pong timeout"), time.Now().Add(time.Second))
		c.wsConn.Close() //nolint:errcheck — the read loop records the failure
		return
	}
	c.pongOutstanding = true
	conn := c.wsConn
	c.pingTimer = time.AfterFunc(c.pingInterval, c.pingTick)
	c.mu.Unlock()

	// pingTick is the only data-frame writer on this connection.
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		c.log.Debug("Ping write failed", "error", err)
	}
}

func (c *WsChannel) clearTimersLocked() {
	if c.pingTimer != nil {
		c.pingTimer.Stop()
		c.pingTimer = nil
	}
	if c.reconnectTimer != nil {
		c.reconnectTimer.Stop()
		c.reconnectTimer = nil
	}
	c.pongOutstanding = false
}

// WsURL converts an http(s) control-plane base URL to ws(s).
func WsURL(baseURL string) string {
	return strings.Replace(baseURL, "http", "ws", 1) + "/api/agent/ws"
}
