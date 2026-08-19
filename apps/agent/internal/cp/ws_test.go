package cp

import (
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestWsChannelFallbackAndRecovery drives the channel state machine: nothing
// is listening at first, so three dial failures demote the channel to poll
// mode; once a server appears, the next probe reconnects, recovers ws mode,
// and delivers a config_changed push. The heartbeat (ping/pong) must keep the
// connection alive across several ping intervals.
func TestWsChannelFallbackAndRecovery(t *testing.T) {
	addr := "127.0.0.1:59125"
	url := "ws://" + addr + "/api/agent/ws"

	fallbacks := make(chan struct{}, 4)
	recovered := make(chan struct{}, 1)
	changed := make(chan struct{}, 4)

	log := slog.New(slog.NewTextHandler(&discardWriter{}, &slog.HandlerOptions{Level: slog.LevelError}))

	channel := NewWsChannel(WsChannelOptions{
		URL:           url,
		NodeToken:     "test-token",
		ProbeInterval: 300 * time.Millisecond,
		PingInterval:  300 * time.Millisecond,
	}, WsChannelEvents{
		OnConfigChanged: func() { changed <- struct{}{} },
		OnFallback:      func() { fallbacks <- struct{}{} },
		OnRecovered:     func() { recovered <- struct{}{} },
	}, log)
	channel.Start()
	defer channel.Stop()

	// Phase 1: dial failures (1s, then 2s backoff) accumulate to the
	// threshold and demote the channel to poll mode.
	select {
	case <-fallbacks:
	case <-time.After(10 * time.Second):
		t.Fatal("channel never fell back to poll mode")
	}
	if channel.Mode() != ModePoll {
		t.Fatalf("mode = %s, want poll", channel.Mode())
	}
	if channel.PreferWS() {
		t.Fatal("PreferWS must be false in poll mode")
	}

	// Phase 2: bring the server up; the next probe should recover ws mode.
	server := startWsServer(t, addr)
	defer server.Close()

	select {
	case <-recovered:
	case <-time.After(10 * time.Second):
		t.Fatal("channel never recovered to ws mode")
	}
	if !channel.PreferWS() {
		t.Fatal("PreferWS must be true after recovery")
	}

	// Phase 3: the server pushes a config change on connect.
	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Fatal("config_changed push never arrived")
	}

	// Phase 4: heartbeat keeps the connection alive (a pong timeout would
	// tear it down within ~2 ping intervals).
	time.Sleep(1 * time.Second)
	if !channel.PreferWS() {
		t.Fatal("connection did not survive heartbeats")
	}
}

// TestWsChannelReconnectWakesAfterGap pins the push-hole fix: a single
// disconnect (far below the 3-in-60s demotion threshold) followed by a
// reconnect must fire OnConnected — an immediate poll — because any
// config_changed broadcast during the down window is lost.
func TestWsChannelReconnectWakesAfterGap(t *testing.T) {
	addr := "127.0.0.1:59126"
	url := "ws://" + addr + "/api/agent/ws"

	connected := make(chan struct{}, 4)
	log := slog.New(slog.NewTextHandler(&discardWriter{}, &slog.HandlerOptions{Level: slog.LevelError}))

	channel := NewWsChannel(WsChannelOptions{
		URL:           url,
		NodeToken:     "test-token",
		ProbeInterval: 300 * time.Millisecond,
		PingInterval:  60 * time.Second, // no heartbeat interference
	}, WsChannelEvents{
		OnConnected: func() { connected <- struct{}{} },
	}, log)
	channel.Start()
	defer channel.Stop()

	// A minimal server whose live connection can be dropped on demand.
	var connMu sync.Mutex
	var active *websocket.Conn
	upgrader := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		connMu.Lock()
		active = conn
		connMu.Unlock()
		for { // hold the connection open
			conn.SetReadDeadline(time.Now().Add(30 * time.Second))
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("listen %s: %v", addr, err)
	}
	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: mux}}
	server.Start()
	defer server.Close()

	// First connect fires OnConnected.
	select {
	case <-connected:
	case <-time.After(10 * time.Second):
		t.Fatal("OnConnected never fired on first connect")
	}

	// Drop the connection once (no demotion). The channel reconnects with
	// backoff, and the reconnect must fire OnConnected again.
	connMu.Lock()
	drop := active
	connMu.Unlock()
	if drop == nil {
		t.Fatal("server never saw a connection")
	}
	drop.Close() //nolint:errcheck

	select {
	case <-connected:
	case <-time.After(15 * time.Second):
		t.Fatal("OnConnected never fired after reconnecting from a single drop")
	}
	if channel.Mode() != ModeWS {
		t.Fatalf("mode = %s, want ws (single drop must not demote)", channel.Mode())
	}
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }

// startWsServer serves the control-plane side of the channel: hello on
// connect, config_changed shortly after, and pong replies to app-level pings.
func startWsServer(t *testing.T, addr string) *httptest.Server {
	t.Helper()

	upgrader := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		if r.Header.Get("Authorization") != "Bearer test-token" {
			conn.WriteControl(websocket.CloseMessage, //nolint:errcheck
				websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "bad token"),
				time.Now().Add(time.Second))
			return
		}

		// gorilla allows a single concurrent writer.
		var writeMu sync.Mutex
		write := func(data string) {
			writeMu.Lock()
			defer writeMu.Unlock()
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			conn.WriteMessage(websocket.TextMessage, []byte(data)) //nolint:errcheck
		}

		write(`{"type":"hello"}`)
		go func() {
			time.Sleep(150 * time.Millisecond)
			write(`{"type":"config_changed"}`)
		}()

		for {
			conn.SetReadDeadline(time.Now().Add(10 * time.Second))
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if string(data) == "ping" {
				write("pong")
			}
		}
	})

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("listen %s: %v", addr, err)
	}
	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: mux}}
	server.Start()
	return server
}

// TestWsChannelRestartDirective checks the restart_service control message
// reaches OnRestartService with the service name.
func TestWsChannelRestartDirective(t *testing.T) {
	addr := "127.0.0.1:59127"
	restarts := make(chan string, 2)
	log := slog.New(slog.NewTextHandler(&discardWriter{}, &slog.HandlerOptions{Level: slog.LevelError}))

	upgrader := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"restart_service","service":"service-14"}`)) //nolint:errcheck
		for {
			conn.SetReadDeadline(time.Now().Add(30 * time.Second))
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: mux}}
	server.Start()
	defer server.Close()

	channel := NewWsChannel(WsChannelOptions{
		URL:          "ws://" + addr + "/api/agent/ws",
		NodeToken:    "test-token",
		PingInterval: 60 * time.Second,
	}, WsChannelEvents{
		OnRestartService: func(service string) { restarts <- service },
	}, log)
	channel.Start()
	defer channel.Stop()

	select {
	case svc := <-restarts:
		if svc != "service-14" {
			t.Fatalf("service = %q, want service-14", svc)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("restart_service directive never arrived")
	}
}

// TestWsURL checks the http→ws base URL conversion.
func TestWsURL(t *testing.T) {
	cases := map[string]string{
		"http://localhost:8787":  "ws://localhost:8787/api/agent/ws",
		"https://cp.example.com": "wss://cp.example.com/api/agent/ws",
	}
	for in, want := range cases {
		if got := WsURL(in); got != want {
			t.Errorf("WsURL(%q) = %q, want %q", in, got, want)
		}
	}
}
