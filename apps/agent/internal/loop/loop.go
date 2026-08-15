// Package loop is the agent's control loop: it polls the control plane for
// config versions (with the WebSocket channel as the fast path and HTTP
// polling as fallback/safety net), applies new configs, and buffers/batches
// GOST stats samples for upload.
package loop

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/laoshan-tech/tyz-node/apps/agent/internal/cp"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/model"
)

const (
	maxBackoff = 5 * time.Minute
	// Upper bound so a long control-plane outage cannot grow memory without limit.
	maxBufferedStats = 1000
	// While the WebSocket push channel is healthy, polling is only a safety net.
	safetyPollInterval = 5 * time.Minute
)

// ApplyConfig renders and applies a fetched NodeConfigData to the embedded
// GOST runtime (wired to builder + gostapply in main).
type ApplyConfig func(data *model.NodeConfigData) error

type Options struct {
	PollInterval       time.Duration
	StatsFlushInterval time.Duration
	// WsChannel is optional; without it the loop always polls at PollInterval.
	Ws *cp.WsChannel
	// CachePath optionally persists the last applied config and re-applies it
	// at startup (offline bootstrap); empty disables the cache.
	CachePath string
	Apply     ApplyConfig
}

type Loop struct {
	client *cp.Client
	opts   Options
	log    *slog.Logger

	configVersion int64

	statsMu sync.Mutex
	stats   []model.GostStatsSample

	wakeCh chan struct{}

	// flushGate serializes flush attempts and keeps the in-flight slice logic simple.
	flushMu sync.Mutex
}

func New(client *cp.Client, opts Options, log *slog.Logger) *Loop {
	return &Loop{
		client: client,
		opts:   opts,
		log:    log,
		wakeCh: make(chan struct{}, 1),
	}
}

// SetWSChannel attaches the push channel after construction (the channel's
// events reference the loop, so both are created first and wired afterwards).
func (l *Loop) SetWSChannel(ws *cp.WsChannel) {
	l.opts.Ws = ws
}

// Start begins the poll loop and the stats flush ticker; it returns when ctx
// is done, after a best-effort final stats flush.
func (l *Loop) Start(ctx context.Context) {
	l.bootstrapFromCache()

	l.log.Info("Starting control plane client",
		"pollInterval", l.opts.PollInterval.String(),
		"statsFlushInterval", l.opts.StatsFlushInterval.String(),
		"wsEnabled", l.opts.Ws != nil)

	if l.opts.Ws != nil {
		l.opts.Ws.Start()
	}

	flushDone := make(chan struct{})
	go func() {
		defer close(flushDone)
		ticker := time.NewTicker(l.opts.StatsFlushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := l.flushStats(ctx); err != nil {
					l.log.Error("Stats flush failed", "error", err)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	l.pollLoop(ctx)

	// Best-effort final upload of anything still buffered.
	flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := l.flushStats(flushCtx); err != nil {
		l.log.Error("Final stats flush failed", "error", err)
	}
	<-flushDone
	l.log.Info("Control plane client stopped")
}

// Wake triggers an immediate poll (config push arrived or channel mode changed).
func (l *Loop) Wake() {
	select {
	case l.wakeCh <- struct{}{}:
	default: // a wake is already pending
	}
}

// Enqueue buffers one stats sample from the GOST observer (drop-oldest at cap).
func (l *Loop) Enqueue(sample model.GostStatsSample) {
	l.statsMu.Lock()
	if len(l.stats) >= maxBufferedStats {
		l.stats = l.stats[1:]
	}
	l.stats = append(l.stats, sample)
	buffered := len(l.stats)
	l.statsMu.Unlock()
	l.log.Debug("Stats buffered", "service", sample.Service, "buffered", buffered)
}

// pollInterval returns the polling cadence: rare safety net while the push
// channel is healthy, otherwise the configured interval.
func (l *Loop) pollInterval() time.Duration {
	if l.opts.Ws != nil && l.opts.Ws.PreferWS() {
		return safetyPollInterval
	}
	return l.opts.PollInterval
}

func (l *Loop) pollLoop(ctx context.Context) {
	backoff := time.Duration(0)
	for {
		delay := l.pollInterval()
		if err := l.pollOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			if backoff == 0 {
				backoff = l.opts.PollInterval
			} else {
				backoff *= 2
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
			}
			delay = backoff
			l.log.Error("Control plane poll failed, backing off", "error", err, "retryIn", delay.String())
		} else {
			backoff = 0
		}

		// A push (or a channel mode change) may have arrived while we were
		// busy; consume it and poll again immediately instead of sleeping.
		select {
		case <-l.wakeCh:
			continue
		default:
		}

		timer := time.NewTimer(delay + jitter(delay))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-l.wakeCh:
			timer.Stop()
			continue
		case <-timer.C:
		}
	}
}

func (l *Loop) pollOnce(ctx context.Context) error {
	resp, changed, err := l.client.FetchConfig(ctx, l.configVersion)
	if err != nil {
		return err
	}
	if !changed || resp.Version <= l.configVersion {
		l.log.Debug("Config unchanged")
		return nil
	}

	l.log.Info("Applying config update from control plane",
		"nodeId", resp.Config.Node.ID,
		"version", resp.Version,
		"rules", len(resp.Config.Rules),
		"tunnels", len(resp.Config.Tunnels),
		"chains", len(resp.Config.Chains))

	if err := l.opts.Apply(&resp.Config); err != nil {
		// The version is only adopted on success so the next poll retries.
		return err
	}
	l.configVersion = resp.Version
	l.saveCache(resp)
	l.log.Info("Config update applied", "version", resp.Version)
	return nil
}

func (l *Loop) flushStats(ctx context.Context) error {
	l.statsMu.Lock()
	if len(l.stats) == 0 {
		l.statsMu.Unlock()
		return nil
	}
	samples := l.stats
	l.statsMu.Unlock()

	// Upload outside the buffer lock; concurrent flushes serialize here.
	l.flushMu.Lock()
	defer l.flushMu.Unlock()

	if err := l.client.UploadStats(ctx, samples); err != nil {
		return err
	}

	// Keep only samples queued while this request was in flight.
	l.statsMu.Lock()
	if n := len(samples); len(l.stats) >= n {
		l.stats = l.stats[n:]
	} else {
		l.stats = nil
	}
	l.statsMu.Unlock()
	l.log.Debug("Stats uploaded", "count", len(samples))
	return nil
}

func jitter(base time.Duration) time.Duration {
	return time.Duration(rand.Int64N(int64(min(base/4, 5*time.Second))))
}
