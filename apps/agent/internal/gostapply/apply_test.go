package gostapply

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"testing"
	"time"

	corelistener "github.com/go-gost/core/listener"
	corelogger "github.com/go-gost/core/logger"
	"github.com/go-gost/x/config"
	xquota "github.com/go-gost/x/limiter/quota"
	xlogger "github.com/go-gost/x/logger"
	"github.com/go-gost/x/registry"
	"github.com/laoshan-tech/tyz/apps/agent/internal/builder"
	"github.com/laoshan-tech/tyz/apps/agent/internal/certs"
	_ "github.com/laoshan-tech/tyz/apps/agent/internal/drivers"
	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
	"github.com/laoshan-tech/tyz/apps/agent/internal/statsobs"
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

// TestApplyLifecycle exercises the create / idempotent re-apply / update /
// delete lifecycle of services.
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

// TestApplyTwoNodeRelay exercises the chain path (ParseChain requires a
// non-nil logger) plus the entry/exit shapes from the two-node fixture.
func TestApplyTwoNodeRelay(t *testing.T) {
	a := testApplier(t)

	raw, err := os.ReadFile("../builder/testdata/two-node-example.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		Entry *model.NodeConfigData `json:"entry"`
		Exit  *model.NodeConfigData `json:"exit"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}

	applyRaw := func(data *model.NodeConfigData) {
		t.Helper()
		cfg, err := builder.Build(data)
		if err != nil {
			t.Fatalf("build: %v", err)
		}
		if err := a.Apply(cfg); err != nil {
			t.Fatalf("apply: %v", err)
		}
	}

	applyRaw(fixture.Exit)
	if !registry.ServiceRegistry().IsRegistered("service-t2") || registry.ServiceRegistry().IsRegistered("service-2") {
		t.Fatal("exit should register only the shared relay service service-t2")
	}

	applyRaw(fixture.Entry)
	if !registry.ChainRegistry().IsRegistered("chain-2") {
		t.Fatal("entry chain chain-2 not registered")
	}
	for _, name := range []string{"service-2", "service-3"} {
		if !registry.ServiceRegistry().IsRegistered(name) {
			t.Fatalf("%s not registered after entry apply", name)
		}
	}

	// Re-applying the exit config must tear the entry objects back down.
	applyRaw(fixture.Exit)
	if registry.ServiceRegistry().IsRegistered("service-2") || !registry.ServiceRegistry().IsRegistered("service-t2") {
		t.Fatal("re-apply of exit config should remove entry services")
	}
	registry.ChainRegistry().Unregister("chain-2")
	registry.ServiceRegistry().Unregister("service-t2")
}

// TestHealthSnapshot checks the runtime-state surface: every registered
// service appears, reaches "ready" once Serve() starts, and disappears after
// the objects are torn down.
func TestHealthSnapshot(t *testing.T) {
	a := testApplier(t)

	applyData(t, a, model.RelayRule{ID: 7, ListenPort: 48107, Targets: "example.com:80"})

	// Serve() sets ready asynchronously right after registration.
	deadline := time.Now().Add(2 * time.Second)
	for {
		snap := a.HealthSnapshot()
		if len(snap) != 1 || snap[0].Service != "service-7" {
			t.Fatalf("expected exactly service-7 in snapshot, got %+v", snap)
		}
		if snap[0].State == "ready" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("service-7 did not reach ready state: %+v", snap[0])
		}
		time.Sleep(10 * time.Millisecond)
	}

	applyData(t, a) // empty config removes every object
	if snap := a.HealthSnapshot(); len(snap) != 0 {
		t.Fatalf("expected empty snapshot after teardown, got %+v", snap)
	}
}

// TestApplyQuotaLifecycle covers the traffic-quota path: create, same-window
// limit refresh (counter window unchanged), window change (counter reset),
// and teardown with the rule.
func TestApplyQuotaLifecycle(t *testing.T) {
	// Quota objects persist to a store file in the working directory; keep the
	// test's writes out of the repo.
	restoreChdir(t)

	a := testApplier(t)
	withQuota := model.RelayRule{
		ID: 9, ListenPort: 48109, Targets: "example.com:80",
		Quota: &model.RuleQuota{
			Name:       "quota-user-9",
			LimitBytes: 1048576,
			StartsAt:   "2026-08-01T00:00:00Z",
			ExpiresAt:  "2026-09-01T00:00:00Z",
		},
	}

	applyData(t, a, withQuota)
	if !registry.QuotaLimiterRegistry().IsRegistered("quota-user-9") {
		t.Fatal("quota-user-9 not registered")
	}
	if snap := quotaSnapshot(t, "quota-user-9"); snap.Limit != 1048576 || snap.ExpiresAtUnix == 0 {
		t.Fatalf("unexpected quota snapshot: %+v", snap)
	}

	// Same window, refreshed remaining: the object swaps, the window stays.
	more := withQuota
	more.Quota = &model.RuleQuota{
		Name:       withQuota.Quota.Name,
		LimitBytes: 2097152,
		StartsAt:   withQuota.Quota.StartsAt,
		ExpiresAt:  withQuota.Quota.ExpiresAt,
	}
	applyData(t, a, more)
	if snap := quotaSnapshot(t, "quota-user-9"); snap.Limit != 2097152 {
		t.Fatalf("limit not refreshed: %+v", snap)
	}

	// New window (换购): a fresh counter from zero.
	renewed := withQuota
	renewed.Quota = &model.RuleQuota{
		Name:       withQuota.Quota.Name,
		LimitBytes: 5242880,
		StartsAt:   "2026-09-01T00:00:00Z",
		ExpiresAt:  "2026-10-01T00:00:00Z",
	}
	applyData(t, a, renewed)
	if snap := quotaSnapshot(t, "quota-user-9"); snap.Limit != 5242880 {
		t.Fatalf("limit not updated after renewal: %+v", snap)
	}

	applyData(t, a) // teardown with the rule
	if registry.QuotaLimiterRegistry().IsRegistered("quota-user-9") {
		t.Fatal("quota-user-9 should be removed with its rule")
	}
}

// TestApplyRejectsBrokenChainBeforeMutating pins the two-phase behavior: a
// desired config whose chain fails to parse is rejected wholesale, leaving the
// previously applied objects fully intact (no half-torn-down state).
func TestApplyRejectsBrokenChainBeforeMutating(t *testing.T) {
	a := testApplier(t)
	applyData(t, a, model.RelayRule{ID: 3, ListenPort: 48103, Targets: "example.com:80"})
	if !registry.ServiceRegistry().IsRegistered("service-3") {
		t.Fatal("service-3 missing before broken apply")
	}

	broken := &config.Config{
		Services: []*config.ServiceConfig{{
			Name:     "service-3",
			Addr:     ":48103",
			Handler:  &config.HandlerConfig{Type: "tcp", Chain: "chain-broken"},
			Listener: &config.ListenerConfig{Type: "tcp"},
		}},
		Chains: []*config.ChainConfig{{
			Name: "chain-broken",
			Hops: []*config.HopConfig{{
				Name:  "hop-broken",
				Nodes: []*config.NodeConfig{{Name: "n", Addr: "127.0.0.1:1", Connector: &config.ConnectorConfig{Type: "does-not-exist"}, Dialer: &config.DialerConfig{Type: "tcp"}}},
			}},
		}},
	}
	if err := a.Apply(broken); err == nil {
		t.Fatal("expected the broken chain to fail validation")
	}

	// The old service must still be registered and the unknown chain absent.
	if !registry.ServiceRegistry().IsRegistered("service-3") {
		t.Fatal("service-3 must survive a rejected apply")
	}
	if registry.ChainRegistry().IsRegistered("chain-broken") {
		t.Fatal("chain-broken must not be registered after a rejected apply")
	}
}

// TestApplySkipsFailedServiceAndRetries pins the partial-failure semantics:
// one service whose ParseService fails (unknown listener type) does NOT abort
// the apply — everything else registers — but Apply still returns an error so
// the control loop does not adopt the version. Re-applying the same desired
// config after the failure is fixed succeeds WITHOUT rebuilding the healthy
// service (a.last tracks the desired state even on partial failure).
func TestApplySkipsFailedServiceAndRetries(t *testing.T) {
	a := testApplier(t)

	good := model.RelayRule{ID: 11, ListenPort: 48111, Targets: "example.com:80"}
	// Port 1 with a tcp listener fails to bind as non-root — the reliable way
	// to make ParseService error without depending on an occupied port.
	bad := model.RelayRule{ID: 12, ListenPort: 1, Targets: "example.com:80"}

	applyDataExpectError(t, a, good, bad)

	if !registry.ServiceRegistry().IsRegistered("service-11") {
		t.Fatal("service-11 must be applied despite service-12 failing")
	}
	if registry.ServiceRegistry().IsRegistered("service-12") {
		t.Fatal("service-12 must not be registered after a parse failure")
	}
	snap := a.HealthSnapshot()
	var failed *model.ServiceHealthSample
	for i := range snap {
		if snap[i].Service == "service-12" {
			failed = &snap[i]
		}
	}
	if failed == nil || failed.State != "apply_failed" || failed.Error == "" {
		t.Fatalf("expected apply_failed health entry for service-12, got %+v", failed)
	}

	// Fixing the rule and re-applying the same desired set succeeds, and the
	// healthy service is NOT torn down for the retry (same last-desired).
	fixed := bad
	fixed.ListenPort = 48112
	applyData(t, a, good, fixed)
	if !registry.ServiceRegistry().IsRegistered("service-12") {
		t.Fatal("service-12 must register once its config is valid")
	}
	// The skipped entry disappears from the health snapshot on success.
	for _, h := range a.HealthSnapshot() {
		if h.State == "apply_failed" {
			t.Fatalf("stale apply_failed entry after successful apply: %+v", h)
		}
	}
}

// TestApplyRebuildsDeadService pins the self-heal path: a service whose accept
// loop exited (StateClosed) is force-rebuilt on the next apply even though its
// config is unchanged.
func TestApplyRebuildsDeadService(t *testing.T) {
	a := testApplier(t)
	rule := model.RelayRule{ID: 13, ListenPort: 48113, Targets: "example.com:80"}
	applyData(t, a, rule)

	// Kill the running service's accept loop: Close() releases the listener,
	// the Serve() goroutine observes net.ErrClosed (non-temporary) and sets
	// StateClosed.
	svc := registry.ServiceRegistry().Get("service-13")
	if svc == nil {
		t.Fatal("service-13 not registered")
	}
	if err := svc.Close(); err != nil {
		t.Fatalf("close service: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if isServiceDead(registry.ServiceRegistry().Get("service-13")) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !isServiceDead(registry.ServiceRegistry().Get("service-13")) {
		t.Fatal("service-13 did not reach closed state after Close")
	}

	// Re-applying the SAME config must resurrect it.
	applyData(t, a, rule)
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snap := a.HealthSnapshot()
		if len(snap) == 1 && snap[0].State == "ready" {
			return // resurrected and serving
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("service-13 not rebuilt to ready after dead-service apply: %+v", a.HealthSnapshot())
}

// applyDataExpectError is applyData for configs expected to partially fail.
func applyDataExpectError(t *testing.T, a *Applier, rules ...model.RelayRule) {
	t.Helper()
	data := &model.NodeConfigData{
		Node:  model.RelayNode{ID: 1, Address: "127.0.0.1", Ports: "40000-40010"},
		Rules: rules,
	}
	cfg, err := builder.Build(data)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if err := a.Apply(cfg); err == nil {
		t.Fatal("expected an aggregate error from the partially-failed apply")
	}
}

// TestRestartService pins the manual-restart path: the service is rebuilt
// from the last applied config (identical object re-registered), an unknown
// name is a no-op, and the restart is recorded in the health snapshot as a
// live (ready) service again.
func TestRestartService(t *testing.T) {
	a := testApplier(t)
	rule := model.RelayRule{ID: 14, ListenPort: 48114, Targets: "example.com:80"}
	applyData(t, a, rule)
	waitReady(t, a, "service-14")

	if err := a.RestartService("service-unknown"); err != nil {
		t.Fatalf("restart of unknown service must be a no-op, got %v", err)
	}
	if err := a.RestartService("service-14"); err != nil {
		t.Fatalf("restart failed: %v", err)
	}
	waitReady(t, a, "service-14")

	applyData(t, a) // teardown
	if err := a.RestartService("service-14"); err != nil {
		t.Fatalf("restart after teardown must be a no-op (not in last config), got %v", err)
	}
}

func waitReady(t *testing.T, a *Applier, name string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, h := range a.HealthSnapshot() {
			if h.Service == name && h.State == "ready" {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s did not reach ready: %+v", name, a.HealthSnapshot())
}

func quotaSnapshot(t *testing.T, name string) xquota.Snapshot {
	t.Helper()
	lim := registry.QuotaLimiterRegistry().Get(name)
	if lim == nil {
		t.Fatalf("quota %s not registered", name)
	}
	return lim.Snapshot()
}

// restoreChdir moves the test's working directory to a temp dir (quota store
// files) and restores it afterwards.
func restoreChdir(t *testing.T) {
	t.Helper()
	orig, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(orig) }) //nolint:errcheck
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

// TestApplyAdmissionLifecycle pins the admission reconcile ordering: objects
// are created BEFORE services parse (they resolve by name) and deleted AFTER
// the referencing services are gone. TLS exit services carry the admission
// reference, so the fixture reuses the relay-tls exit shape.
func TestApplyAdmissionLifecycle(t *testing.T) {
	a := testApplier(t)

	tunnel := model.Tunnel{
		ID: 4, ForwardMode: model.ForwardModeRelay, TLSEnabled: true,
		RelayAuthUser: "u", RelayAuthPass: "p",
	}
	rule := model.RelayRule{ID: 9, ListenPort: 48201, TunnelID: &tunnel.ID, Targets: "127.0.0.1:49180", Status: "running"}
	chains := []model.Chain{
		{ID: 4, TunnelID: 4, NodeID: 1, ChainType: model.ChainIn, Transport: model.TransportRaw, Index: 0, Strategy: "round"},
		{ID: 5, TunnelID: 4, NodeID: 2, ChainType: model.ChainOut, Transport: model.TransportTLS, Index: 1, Strategy: "round", Port: 48211},
	}
	// Real platform-issued PEMs (generated by the control-plane encoder; see
	// internal/certs/testdata/fixture.json) — GOST actually loads these files.
	materialRaw, err := os.ReadFile("../certs/testdata/fixture.json")
	if err != nil {
		t.Fatalf("read tls fixture: %v", err)
	}
	material := &model.TLSMaterial{}
	if err := json.Unmarshal(materialRaw, material); err != nil {
		t.Fatalf("parse tls fixture: %v", err)
	}

	apply := func(t *testing.T, tlsEnabled bool) {
		t.Helper()
		tunnel.TLSEnabled = tlsEnabled
		data := &model.NodeConfigData{
			Node:        model.RelayNode{ID: 2, Address: "127.0.0.1", Ports: "40000-40010"},
			Nodes:       []model.RelayNode{{ID: 1, Address: "127.0.0.1", Ports: "40000-40010"}, {ID: 2, Address: "127.0.0.1", Ports: "40000-40010"}},
			Rules:       []model.RelayRule{rule},
			Tunnels:     []model.Tunnel{tunnel},
			Chains:      chains,
			TLSMaterial: material,
		}
		// Material must be on disk for ParseService to load the cert files.
		dir := t.TempDir()
		if _, err := certs.Ensure(dir, material); err != nil {
			t.Fatalf("certs: %v", err)
		}
		wd, _ := os.Getwd()
		if err := os.Chdir(dir); err != nil {
			t.Fatalf("chdir: %v", err)
		}
		defer os.Chdir(wd) //nolint:errcheck

		cfg, err := builder.Build(data)
		if err != nil {
			t.Fatalf("build: %v", err)
		}
		if err := a.Apply(cfg); err != nil {
			t.Fatalf("apply: %v", err)
		}
	}

	apply(t, true)
	if !registry.AdmissionRegistry().IsRegistered("admission-t4") {
		t.Fatal("admission-t4 not registered alongside the TLS relay service")
	}
	if !registry.ServiceRegistry().IsRegistered("service-t4") {
		t.Fatal("service-t4 not registered")
	}

	// Idempotent re-apply: both stay.
	apply(t, true)
	if !registry.AdmissionRegistry().IsRegistered("admission-t4") || !registry.ServiceRegistry().IsRegistered("service-t4") {
		t.Fatal("objects lost after idempotent re-apply")
	}

	// Dropping TLS removes the admission reference; the object must be
	// deleted only after the service referencing it was rebuilt.
	apply(t, false)
	if registry.AdmissionRegistry().IsRegistered("admission-t4") {
		t.Fatal("admission-t4 should be deleted once no service references it")
	}
	if !registry.ServiceRegistry().IsRegistered("service-t4") {
		t.Fatal("service-t4 must survive the TLS removal")
	}

	// Empty config removes everything.
	if err := a.Apply(&config.Config{}); err != nil {
		t.Fatalf("apply empty: %v", err)
	}
	if n := len(registry.ServiceRegistry().GetAll()); n != 0 {
		t.Fatalf("expected 0 services after empty apply, got %d", n)
	}
	if len(registry.AdmissionRegistry().GetAll()) != 0 {
		t.Fatal("expected 0 admissions after empty apply")
	}
}

// TestApplyTLSMaterialChange pins the WithTLSMaterialChange option: a PEM
// rotation does not alter the config structs (they carry file paths only), so
// without the option the TLS service and chain stay as-is and the new cert
// never loads; with the option the service is closed and re-served (new
// instance, connections dropped) and the chain is re-registered.
func TestApplyTLSMaterialChange(t *testing.T) {
	a := testApplier(t)

	tunnel := model.Tunnel{ID: 4, ForwardMode: model.ForwardModeRelay, TLSEnabled: true}
	chains := []model.Chain{
		{ID: 4, TunnelID: 4, NodeID: 1, ChainType: model.ChainIn, Transport: model.TransportRaw, Index: 0, Strategy: "round"},
		{ID: 5, TunnelID: 4, NodeID: 2, ChainType: model.ChainOut, Transport: model.TransportTLS, Index: 1, Strategy: "round", Port: 48221},
	}
	materialRaw, err := os.ReadFile("../certs/testdata/fixture.json")
	if err != nil {
		t.Fatalf("read tls fixture: %v", err)
	}
	material := &model.TLSMaterial{}
	if err := json.Unmarshal(materialRaw, material); err != nil {
		t.Fatalf("parse tls fixture: %v", err)
	}

	// Exit-side data (TLS relay service) and entry-side data (chain with a
	// TLS dialer + plain rule services) share the tunnel, but a single
	// process has ONE registry: each apply tears down what its desired set
	// lacks, so the two sides are exercised sequentially, never concurrently.
	build := func(nodeID int, rules []model.RelayRule) *config.Config {
		t.Helper()
		data := &model.NodeConfigData{
			Node:        model.RelayNode{ID: nodeID, Address: "127.0.0.1", Ports: "40000-40010"},
			Nodes:       []model.RelayNode{{ID: 1, Address: "127.0.0.1", Ports: "40000-40010"}, {ID: 2, Address: "127.0.0.1", Ports: "40000-40010"}},
			Rules:       rules,
			Tunnels:     []model.Tunnel{tunnel},
			Chains:      chains,
			TLSMaterial: material,
		}
		cfg, err := builder.Build(data)
		if err != nil {
			t.Fatalf("build: %v", err)
		}
		return cfg
	}
	dir := t.TempDir()
	if _, err := certs.Ensure(dir, material); err != nil {
		t.Fatalf("certs: %v", err)
	}
	wd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() { os.Chdir(wd) }) //nolint:errcheck

	// ---- exit side: the TLS relay service ----
	rules := []model.RelayRule{{ID: 9, ListenPort: 48231, TunnelID: &tunnel.ID, Targets: "127.0.0.1:49180", Status: "running"}}
	exitCfg := build(2, rules)
	if err := a.Apply(exitCfg); err != nil {
		t.Fatalf("apply exit: %v", err)
	}
	svcBefore := registry.ServiceRegistry().Get("service-t4")
	if svcBefore == nil {
		t.Fatal("service-t4 not registered")
	}
	// Identical config without the option: true no-op (same instance).
	if err := a.Apply(exitCfg); err != nil {
		t.Fatalf("apply exit (no change): %v", err)
	}
	if registry.ServiceRegistry().Get("service-t4") != svcBefore {
		t.Fatal("unchanged config without the option must not rebuild the service")
	}
	// With the option: closed and re-served — a NEW instance.
	if err := a.Apply(exitCfg, WithTLSMaterialChange()); err != nil {
		t.Fatalf("apply exit (material change): %v", err)
	}
	if got := registry.ServiceRegistry().Get("service-t4"); got == nil || got == svcBefore {
		t.Fatal("TLS service must be rebuilt (new instance) on material change")
	}
	if err := a.Apply(&config.Config{}); err != nil {
		t.Fatalf("apply empty: %v", err)
	}

	// ---- entry side: the TLS chain dialer + a plain (non-TLS) rule service ----
	entryCfg := build(1, rules)
	if err := a.Apply(entryCfg); err != nil {
		t.Fatalf("apply entry: %v", err)
	}
	chainBefore := registry.ChainRegistry().Get("chain-4")
	plainBefore := registry.ServiceRegistry().Get("service-9")
	if chainBefore == nil || plainBefore == nil {
		t.Fatal("chain-4/service-9 not registered")
	}
	// With the option: the TLS chain re-registers (new resolved dialer certs);
	// the plain service has no TLS listener and must NOT be rebuilt.
	if err := a.Apply(entryCfg, WithTLSMaterialChange()); err != nil {
		t.Fatalf("apply entry (material change): %v", err)
	}
	if got := registry.ChainRegistry().Get("chain-4"); got == nil || got == chainBefore {
		t.Fatal("TLS chain must be re-registered on material change")
	}
	if registry.ServiceRegistry().Get("service-9") != plainBefore {
		t.Fatal("non-TLS service must not be rebuilt on material change")
	}
	if err := a.Apply(&config.Config{}); err != nil {
		t.Fatalf("apply empty: %v", err)
	}
}

// TestIsNormalServeExit pins the normal-exit detection for both closed-listener
// error families: stdlib net.ErrClosed (plain net listeners) and go-gost
// core's listener.ErrClosed (custom transports — grpc/ws/quic/...), including
// wrapped forms. A mis-classified normal exit logs ERROR on every service
// replacement/shutdown of such services.
func TestIsNormalServeExit(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{net.ErrClosed, true},
		{corelistener.ErrClosed, true},
		{fmt.Errorf("accept: %w", net.ErrClosed), true},
		{fmt.Errorf("accept: %w", corelistener.ErrClosed), true},
		{errors.New("listen: bind: address already in use"), false},
	}
	for _, tc := range cases {
		if got := isNormalServeExit(tc.err); got != tc.want {
			t.Errorf("isNormalServeExit(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}
