// tyz-agent: relay-node agent with the GOST runtime embedded in-process.
//
// It polls the control plane for config versions (WebSocket push first, HTTP
// polling fallback), renders NodeConfigData into GOST objects and applies
// them directly through the GOST registries, and forwards observer stats in
// batches. Its own HTTP surface is a single health endpoint.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	corelogger "github.com/go-gost/core/logger"
	apiservice "github.com/go-gost/x/api/service"
	"github.com/go-gost/x/config/parsing"
	xlogger "github.com/go-gost/x/logger"
	"github.com/go-gost/x/registry"

	"github.com/laoshan-tech/tyz-node/apps/agent/internal/agentcfg"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/builder"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/certs"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/cp"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/gostapply"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/loop"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/model"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/statsobs"
)

// configCachePath is where the last applied config is persisted (working
// directory, i.e. /var/lib/tyz in the container — mount it to keep tunnels
// alive across restarts during control-plane outages).
const configCachePath = "last-config.json"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
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
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	// GOST components log through their own logger interface; route it to
	// stdout too so service lifecycle events are visible next to agent logs.
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
			if err := certs.Ensure(".", data.TLSMaterial); err != nil {
				return fmt.Errorf("persist tls material: %w", err)
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
			return applier.Apply(gostConfig)
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

	if cfg.GostAPIAddr != "" {
		svc, err := apiservice.NewService("tcp", cfg.GostAPIAddr, apiservice.PathPrefixOption("/api"))
		if err != nil {
			return fmt.Errorf("start gost api: %w", err)
		}
		go func() {
			if err := svc.Serve(); err != nil {
				log.Error("GOST debug api stopped", "error", err)
			}
		}()
		log.Info("GOST debug api listening", "addr", cfg.GostAPIAddr)
	}

	healthServer := startHealthServer(cfg, log)
	log.Info("Server started",
		"health", fmt.Sprintf("http://%s:%d/healthz", cfg.Host, cfg.Port),
		"controlPlane", cfg.ControlPlaneURL)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	loopDone := make(chan struct{})
	go func() {
		defer close(loopDone)
		ctl.Start(ctx)
	}()

	<-ctx.Done()
	log.Info("Shutting down...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := healthServer.Shutdown(shutdownCtx); err != nil {
		log.Error("Health server shutdown failed", "error", err)
	}

	<-loopDone // includes the final stats flush
	applier.Shutdown()
	log.Info("Shutdown complete")
	return nil
}

func startHealthServer(cfg *agentcfg.Config, log *slog.Logger) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(fmt.Sprintf( //nolint:errcheck
			`{"status":"ok","timestamp":%q,"service":"tyz-agent"}`, time.Now().UTC().Format(time.RFC3339))))
	})

	server := &http.Server{Addr: fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), Handler: mux}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("Health server failed", "error", err)
			os.Exit(1)
		}
	}()
	return server
}
