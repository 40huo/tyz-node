package gostapply

import (
	"log/slog"
	"os"
	"testing"

	corelogger "github.com/go-gost/core/logger"
	xlogger "github.com/go-gost/x/logger"
	"github.com/go-gost/x/registry"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/builder"
	_ "github.com/laoshan-tech/tyz-node/apps/agent/internal/drivers"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/model"
	"github.com/laoshan-tech/tyz-node/apps/agent/internal/statsobs"
)

type sliceQueue struct{ samples []model.GostStatsSample }

func (q *sliceQueue) Enqueue(s model.GostStatsSample) { q.samples = append(q.samples, s) }

func testApplier(t *testing.T) *Applier {
	t.Helper()
	// GOST's parsers require a default logger (main sets one in production).
	if corelogger.Default() == nil {
		corelogger.SetDefault(xlogger.NewLogger(xlogger.OutputOption(os.Stdout)))
	}
	// Services reference the stats observer by name at parse time.
	if !registry.ObserverRegistry().IsRegistered(builder.ObserverName) {
		if err := registry.ObserverRegistry().Register(builder.ObserverName, statsobs.New(&sliceQueue{})); err != nil {
			t.Fatalf("register observer: %v", err)
		}
	}
	return New(slog.New(slog.NewTextHandler(&discard{}, nil)))
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func applyData(t *testing.T, a *Applier, rules ...model.RelayRule) {
	t.Helper()
	data := &model.NodeConfigData{
		Node:  model.RelayNode{ID: 1, Address: "127.0.0.1", Ports: "40000-40010"},
		Rules: rules,
	}
	cfg, err := builder.Build(data)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if err := a.Apply(cfg); err != nil {
		t.Fatalf("apply: %v", err)
	}
}

func TestApplyLifecycle(t *testing.T) {
	a := testApplier(t)

	// Create two services.
	applyData(t, a,
		model.RelayRule{ID: 1, ListenPort: 48101, Targets: "example.com:80"},
		model.RelayRule{ID: 2, ListenPort: 48102, Targets: "example.com:81"},
	)
	for _, name := range []string{"service-1", "service-2"} {
		if !registry.ServiceRegistry().IsRegistered(name) {
			t.Fatalf("%s not registered after first apply", name)
		}
	}

	// Re-apply the same desired config: nothing to do, objects stay.
	applyData(t, a,
		model.RelayRule{ID: 1, ListenPort: 48101, Targets: "example.com:80"},
		model.RelayRule{ID: 2, ListenPort: 48102, Targets: "example.com:81"},
	)
	if len(registry.ServiceRegistry().GetAll()) != 2 {
		t.Fatalf("expected 2 services after idempotent apply, got %d", len(registry.ServiceRegistry().GetAll()))
	}

	// Change one service (new port) and drop the other.
	applyData(t, a, model.RelayRule{ID: 1, ListenPort: 48111, Targets: "example.com:80"})
	if !registry.ServiceRegistry().IsRegistered("service-1") {
		t.Fatal("service-1 missing after update")
	}
	if registry.ServiceRegistry().IsRegistered("service-2") {
		t.Fatal("service-2 should have been deleted")
	}

	// Empty config removes everything.
	applyData(t, a)
	if n := len(registry.ServiceRegistry().GetAll()); n != 0 {
		t.Fatalf("expected 0 services after empty apply, got %d", n)
	}
}

// TestApplyLimiterHotSwap checks limiters are created and removed with the
// services that reference them.
func TestApplyLimiterHotSwap(t *testing.T) {
	a := testApplier(t)

	withLimit := model.RelayRule{
		ID: 5, ListenPort: 48105, Targets: "example.com:80",
		Limit: []byte(`{"traffic":{"service_in":10240,"service_out":20480},"request":{"service_rate":100},"connection":{"service_limit":50}}`),
	}
	applyData(t, a, withLimit)
	if !registry.TrafficLimiterRegistry().IsRegistered("limiter-service-5") ||
		!registry.RateLimiterRegistry().IsRegistered("rlimiter-service-5") ||
		!registry.ConnLimiterRegistry().IsRegistered("climiter-service-5") {
		t.Fatal("limiters not registered")
	}

	applyData(t, a)
	if registry.TrafficLimiterRegistry().IsRegistered("limiter-service-5") ||
		registry.RateLimiterRegistry().IsRegistered("rlimiter-service-5") ||
		registry.ConnLimiterRegistry().IsRegistered("climiter-service-5") {
		t.Fatal("limiters should have been removed")
	}
}
