// tyz-agent: relay-node agent with the GOST runtime embedded in-process.
//
// It polls the control plane for config versions (WebSocket push first, HTTP
// polling fallback), renders NodeConfigData into GOST objects and applies
// them directly through the GOST registries, and forwards observer stats in
// batches. It has no HTTP surface of its own — a node is considered healthy
// as long as it keeps reporting. DEBUG=true additionally exposes the embedded
// GOST Web API (read-write, test-only) at GOST_API_ADDR for inspecting the
// actually-applied GOST config.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	corelogger "github.com/go-gost/core/logger"
	apiservice "github.com/go-gost/x/api/service"
	"github.com/go-gost/x/config/parsing"
	xlogger "github.com/go-gost/x/logger"
	"github.com/go-gost/x/registry"

	"github.com/laoshan-tech/tyz/apps/agent/internal/agentcfg"
	"github.com/laoshan-tech/tyz/apps/agent/internal/builder"
	"github.com/laoshan-tech/tyz/apps/agent/internal/certs"
	"github.com/laoshan-tech/tyz/apps/agent/internal/cp"
	"github.com/laoshan-tech/tyz/apps/agent/internal/gostapply"
	"github.com/laoshan-tech/tyz/apps/agent/internal/loop"
	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
	"github.com/laoshan-tech/tyz/apps/agent/internal/statsobs"
)

// configCachePath is where the last applied config is persisted (working
// directory, i.e. /var/lib/tyz in the container — mount it to keep tunnels
// alive across restarts during control-plane outages).
const configCachePath = "last-config.json"

// version is injected at build time via -ldflags "-X main.version=<tag>";
// local builds (go run, e2e-local.sh) keep the "dev" default.
var version = "dev"

// gostStyleHandlerOptions shapes agent log lines to match the embedded GOST
// logger (x/logger): JSON with lowercase logrus-style levels, RFC 3339
// millisecond timestamps, and — at debug level — a "caller" field
// ("dir/file.go:line"). GOST appends caller after its fields while slog emits
// the source attr before msg: same field, slightly different position.
func gostStyleHandlerOptions(level slog.Level, debug bool) *slog.HandlerOptions {
	return &slog.HandlerOptions{
		Level:     level,
		AddSource: debug,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			switch a.Key {
			case slog.TimeKey:
				if t, ok := a.Value.Any().(time.Time); ok {
					a.Value = slog.StringValue(t.Format("2006-01-02T15:04:05.000Z07:00"))
				}
			case slog.LevelKey:
				if l, ok := a.Value.Any().(slog.Level); ok {
					a.Value = slog.StringValue(strings.ToLower(l.String()))
				}
			case slog.SourceKey:
				if src, ok := a.Value.Any().(*slog.Source); ok {
					a.Key = "caller"
					a.Value = slog.StringValue(fmt.Sprintf("%s/%s:%d",
						filepath.Base(filepath.Dir(src.File)), filepath.Base(src.File), src.Line))
				}
			}
			return a
		},
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	// -V and --version are conventional aliases (Go's flag package treats
	// one and two leading dashes identically, so both names cover -V/--V
	// and -version/--version).
	showVersionV := flag.Bool("V", false, "print version and exit")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersionV || *showVersion {
		fmt.Println("tyz-agent", version)
		return nil
	}

	cfg, err := agentcfg.Load()
	if err != nil {
		return err
	}

	level := slog.LevelInfo
	gostLevel := corelogger.InfoLevel
	if cfg.Debug {
		level = slog.LevelDebug
		gostLevel = corelogger.DebugLevel
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, gostStyleHandlerOptions(level, cfg.Debug)))
	slog.SetDefault(log)

	// GOST components log through their own logger interface; route it to
	// stdout too, in the same JSON shape as the agent's own lines above, so
	// service lifecycle events interleave uniformly.
	corelogger.SetDefault(xlogger.NewLogger(
		xlogger.OutputOption(os.Stdout),
		xlogger.LevelOption(gostLevel),
	))

	// Global default certificate for TLS transports without explicit certs
	// (exit-node tls/mtls/wss/mwss listeners). Generated once, persisted under
	// $HOME/.gost and reused across restarts for cert stability.
	if tlsConfig, err := parsing.BuildDefaultTLSConfig(builder.DefaultTLS(nil)); err != nil {
		return fmt.Errorf("build default TLS config: %w", err)
	} else {
		parsing.SetDefaultTLSConfig(tlsConfig)
	}

	cpClient := cp.NewClient(cfg.ControlPlaneURL, cfg.NodeToken)
	applier := gostapply.New(log)

	ctl := loop.New(cpClient, loop.Options{
		PollInterval:       cfg.PollInterval,
		StatsFlushInterval: cfg.StatsFlushInterval,
		// Offline bootstrap: the last applied config is re-applied at startup
		// so tunnels survive a control-plane outage across agent restarts.
		CachePath: configCachePath,
		// Service health snapshot rides along with every stats flush; the
		// control plane stores the latest state per service.
		Health: applier.HealthSnapshot,
		Apply: func(data *model.NodeConfigData) error {
			// Platform link TLS material must be on disk BEFORE Build output is
			// applied — GOST resolves the cert paths at service parse time.
			// No-op when the payload carries no material (and for unchanged
			// content).
			materialChanged, err := certs.Ensure(".", data.TLSMaterial)
			if err != nil {
				return fmt.Errorf("persist tls material: %w", err)
			}
			if materialChanged {
				log.Info("TLS material updated on disk")
			}
			gostConfig, err := builder.Build(data)
			if err != nil {
				return fmt.Errorf("build gost config: %w", err)
			}
			// Re-assert the default cert params from the control plane;
			// no-op once the persisted cert exists.
			if tlsConfig, err := parsing.BuildDefaultTLSConfig(builder.DefaultTLS(data.TLS)); err == nil {
				parsing.SetDefaultTLSConfig(tlsConfig)
			} else {
				log.Warn("Rebuild default TLS config failed", "error", err)
			}
			// A PEM rotation does not change the config structs (they carry
			// file paths only) — force TLS-terminating services and dialers
			// through the rebuild path or the new material never loads.
			var opts []gostapply.ApplyOption
			if materialChanged {
				opts = append(opts, gostapply.WithTLSMaterialChange())
			}
			return applier.Apply(gostConfig, opts...)
		},
	}, log)

	// In-process stats observer, referenced by every generated service.
	if err := registry.ObserverRegistry().Register(builder.ObserverName, statsobs.New(ctl)); err != nil {
		return fmt.Errorf("register stats observer: %w", err)
	}

	var ws *cp.WsChannel
	if cfg.WSenabled {
		ws = cp.NewWsChannel(cp.WsChannelOptions{
			URL:           cp.WsURL(cfg.ControlPlaneURL),
			NodeToken:     cfg.NodeToken,
			ProbeInterval: cfg.WSProbeInterval,
			PingInterval:  cfg.WSPingInterval,
		}, cp.WsChannelEvents{
			OnConfigChanged: ctl.Wake,
			OnFallback:      ctl.Wake,
			OnRecovered:     ctl.Wake,
			// A push may have been missed while (re)connecting — poll now.
			OnConnected: ctl.Wake,
			// Manual rule restart: a pure rebuild of one service from the
			// last applied config (drops its live connections).
			OnRestartService: func(service string) {
				if err := applier.RestartService(service); err != nil {
					log.Warn("Service restart failed", "service", service, "error", err)
				}
			},
		}, log)
		ctl.SetWSChannel(ws)
	}

	// Debug-only: the GOST Web API is a read-write surface for inspecting the
	// actually-applied GOST runtime config (GET /api/config etc.). GostAPIAddr
	// is configurable so the default port can be overridden on conflict.
	if cfg.Debug {
		addr := cfg.GostAPIAddr
		if addr == "" {
			addr = "127.0.0.1:18080"
		}
		svc, err := apiservice.NewService("tcp", addr, apiservice.PathPrefixOption("/api"))
		if err != nil {
			return fmt.Errorf("start gost api: %w", err)
		}
		go func() {
			if err := svc.Serve(); err != nil {
				log.Error("GOST debug api stopped", "error", err)
			}
		}()
		log.Info("GOST debug api listening", "addr", addr)
	}

	log.Info("Agent started", "version", version, "controlPlane", cfg.ControlPlaneURL)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	loopDone := make(chan struct{})
	go func() {
		defer close(loopDone)
		ctl.Start(ctx)
	}()

	<-ctx.Done()
	log.Info("Shutting down...")

	<-loopDone // includes the final stats flush
	applier.Shutdown()
	log.Info("Shutdown complete")
	return nil
}
