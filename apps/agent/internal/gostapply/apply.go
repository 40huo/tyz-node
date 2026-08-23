// Package gostapply applies a desired *config.Config to the embedded GOST
// runtime via the x/registry object registries — the same primitives the GOST
// Web API uses internally, without the HTTP hop.
//
// Semantics (matching the previous Web-API sync):
//   - delete phase runs top-down (services → chains → climiters → rlimiters →
//     limiters) so referencing services disappear before referenced objects;
//   - create/update phase runs bottom-up so dependencies exist first;
//   - chains/limiters hot-swap via Unregister+Register (running services
//     resolve them through registry wrappers on every use);
//   - services are not hot-swappable: changed services are closed, re-parsed
//     and re-served; unchanged ones are left alone.
//
// Change detection compares the desired objects against the last successfully
// applied desired config (in-memory deep equality), not against API echoes.
package gostapply

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"reflect"
	"sort"
	"sync"

	coreadmission "github.com/go-gost/core/admission"
	corechain "github.com/go-gost/core/chain"
	corelistener "github.com/go-gost/core/listener"
	corelogger "github.com/go-gost/core/logger"
	coregistry "github.com/go-gost/core/registry"
	coreservice "github.com/go-gost/core/service"
	"github.com/go-gost/x/config"
	admission_parser "github.com/go-gost/x/config/parsing/admission"
	chain_parser "github.com/go-gost/x/config/parsing/chain"
	limiter_parser "github.com/go-gost/x/config/parsing/limiter"
	quota_parser "github.com/go-gost/x/config/parsing/quota"
	service_parser "github.com/go-gost/x/config/parsing/service"
	"github.com/go-gost/x/registry"
	xservice "github.com/go-gost/x/service"

	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
)

type Applier struct {
	log  *slog.Logger
	mu   sync.Mutex
	last *config.Config
	// skipped holds services whose ParseService failed in the last Apply
	// (name -> reason). They are absent from the registry and reported by
	// HealthSnapshot with state "apply_failed" so the operator sees WHY a
	// rule is not forwarding. Guarded by mu.
	skipped map[string]string
	// forceTLS is set for the duration of one Apply when the caller passed
	// WithTLSMaterialChange: GOST parses cert files once at parse time, so a
	// PEM rotation underneath unchanged config structs (the config references
	// file paths only) must force TLS-terminating services and chain dialers
	// through the changed path or the new material never takes effect.
	forceTLS bool
}

func New(log *slog.Logger) *Applier {
	return &Applier{log: log}
}

// ApplyOption tunes one Apply call.
type ApplyOption func(*Applier)

// WithTLSMaterialChange marks the certs/ files as rewritten since the last
// apply: TLS listeners are closed and re-served (their connections drop) and
// TLS chain dialers are re-registered, even when the config structs are
// unchanged.
func WithTLSMaterialChange() ApplyOption {
	return func(a *Applier) { a.forceTLS = true }
}

// tlsChain reports whether any node of the chain dials with TLS.
func tlsChain(cfg *config.ChainConfig) bool {
	for _, hop := range cfg.Hops {
		for _, node := range hop.Nodes {
			if node != nil && node.Dialer != nil && node.Dialer.TLS != nil {
				return true
			}
		}
	}
	return false
}

// tlsService reports whether the service terminates TLS on its listener.
func tlsService(cfg *config.ServiceConfig) bool {
	return cfg.Listener != nil && cfg.Listener.TLS != nil
}

// Apply diffs desired against the running registries and mutates them.
//
// Failure semantics: a broken chain aborts BEFORE any mutation (validation
// pass). A service that fails to parse — typically a port conflict, since
// ParseService binds — does NOT abort the apply: every other object is
// applied, the failed one is skipped and reported, and Apply returns an
// aggregate error so the control loop does not adopt the version and retries
// on the next poll (recovering transient conflicts like a zombie port
// holder). a.last still records the desired config so the retry does not
// needlessly rebuild the services that DID apply.
func (a *Applier) Apply(desired *config.Config, opts ...ApplyOption) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.forceTLS = false
	for _, opt := range opts {
		opt(a)
	}
	defer func() { a.forceTLS = false }()

	var last *config.Config
	if a.last != nil {
		last = a.last
	} else {
		last = &config.Config{}
	}
	a.skipped = nil

	// Validation pass first: parse every changed chain BEFORE any mutation so
	// a broken desired config is rejected wholesale and the previous config
	// keeps serving (a deterministic parse failure would otherwise retry and
	// fail forever, leaving the node half-torn-down). Services cannot join
	// this pass — ParseService binds its port, which requires the old service
	// to be closed first (gost issue #754) — hence the skip-and-retry
	// handling in reconcileServices below.
	stagedChains, err := a.stageChains(last.Chains, desired.Chains)
	if err != nil {
		return err
	}
	stagedAdmissions, err := a.stageAdmissions(last.Admissions, desired.Admissions)
	if err != nil {
		return err
	}

	// Delete phase, top-down. Admissions go LAST: ParseService resolves them
	// by name, so a referencing service must be gone before its admission is.
	a.deleteKind("services", keySet(registry.ServiceRegistry().GetAll()), desiredSet(serviceNames(desired)))
	a.deleteKind("chains", keySet(registry.ChainRegistry().GetAll()), desiredSet(chainNames(desired)))
	a.deleteKind("quotas", keySet(registry.QuotaLimiterRegistry().GetAll()), desiredSet(quotaNames(desired)))
	a.deleteKind("climiters", keySet(registry.ConnLimiterRegistry().GetAll()), desiredSet(limiterNames(desired.CLimiters)))
	a.deleteKind("rlimiters", keySet(registry.RateLimiterRegistry().GetAll()), desiredSet(limiterNames(desired.RLimiters)))
	a.deleteKind("limiters", keySet(registry.TrafficLimiterRegistry().GetAll()), desiredSet(limiterNames(desired.Limiters)))
	a.deleteKind("admissions", keySet(registry.AdmissionRegistry().GetAll()), desiredSet(admissionNames(desired)))

	// Create/update phase, bottom-up. Admissions go FIRST for the same name
	// resolution reason: a (re)built service parses against the registry.
	if err := a.registerAdmissions(stagedAdmissions); err != nil {
		return err
	}
	if err := reconcileLimiters("limiters", registry.TrafficLimiterRegistry(), limiter_parser.ParseTrafficLimiter, last.Limiters, desired.Limiters, a.log); err != nil {
		return err
	}
	if err := reconcileLimiters("rlimiters", registry.RateLimiterRegistry(), limiter_parser.ParseRateLimiter, last.RLimiters, desired.RLimiters, a.log); err != nil {
		return err
	}
	if err := reconcileLimiters("climiters", registry.ConnLimiterRegistry(), limiter_parser.ParseConnLimiter, last.CLimiters, desired.CLimiters, a.log); err != nil {
		return err
	}
	if err := a.reconcileQuotas(last.Quotas, desired.Quotas); err != nil {
		return err
	}
	if err := a.registerChains(stagedChains); err != nil {
		return err
	}
	skipped := a.reconcileServices(last.Services, desired.Services)

	a.last = desired
	if len(skipped) > 0 {
		a.skipped = skipped
		names := make([]string, 0, len(skipped))
		for name := range skipped {
			names = append(names, name)
		}
		sort.Strings(names)
		return fmt.Errorf("skipped %d service(s) that failed to apply: %v", len(skipped), names)
	}
	// Publish the desired config to the GOST global view so the optional
	// debug API (GOST_API_ADDR) serves it; the registries remain the runtime
	// source of truth.
	config.Set(desired)
	a.log.Info("GOST config synced",
		"services", len(desired.Services), "chains", len(desired.Chains), "quotas", len(desired.Quotas))
	return nil
}

// RestartService rebuilds ONE service from the last applied desired config,
// dropping its live connections — the manual "restart this rule" operation.
// It is deliberately separate from Apply: a restart is an operator action
// that must not smuggle in config changes (the rebuild source is a.last, not
// a fresh fetch), while Apply converges state and never drops connections.
// A service this node does not serve is a no-op (rules span subsets of a
// tunnel's nodes; the broadcast reaches all of them).
func (a *Applier) RestartService(name string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.last == nil {
		return fmt.Errorf("no config applied yet")
	}
	var cfg *config.ServiceConfig
	for _, s := range a.last.Services {
		if s.Name == name {
			cfg = s
			break
		}
	}
	if cfg == nil {
		a.log.Debug("Restart requested for a service this node does not serve", "name", name)
		return nil
	}

	reg := registry.ServiceRegistry()
	if old := reg.Get(name); old != nil {
		if err := old.Close(); err != nil {
			a.log.Warn("GOST service close failed during restart", "name", name, "error", err)
		}
		reg.Unregister(name)
	}
	svc, err := service_parser.ParseService(cfg)
	if err != nil {
		return fmt.Errorf("parse service %q on restart: %w", name, err)
	}
	if err := reg.Register(name, svc); err != nil {
		return fmt.Errorf("register service %q on restart: %w", name, err)
	}
	go func() {
		if err := svc.Serve(); err != nil && !isNormalServeExit(err) {
			a.log.Error("GOST service serve failed after restart", "name", name, "error", err)
		}
	}()
	a.log.Info("GOST service restarted", "name", name)
	return nil
}

// Shutdown closes and unregisters every managed service (used at exit).
func (a *Applier) Shutdown() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for name := range registry.ServiceRegistry().GetAll() {
		registry.ServiceRegistry().Unregister(name)
		a.log.Debug("GOST service stopped", "kind", "services", "name", name)
	}
}

// statusProvider is the runtime-state surface x/service exposes (the same one
// the GOST Web API reads for its service status responses).
type statusProvider interface {
	Status() *xservice.Status
}

// HealthSnapshot returns the current runtime state of every registered
// service, plus "apply_failed" entries for services the last Apply skipped
// (they have no registry presence of their own). State values mirror
// x/service.State (running|ready|failed|closed) plus the synthetic
// apply_failed; a "failed" state carries the last accept error.
func (a *Applier) HealthSnapshot() []model.ServiceHealthSample {
	all := registry.ServiceRegistry().GetAll()
	out := make([]model.ServiceHealthSample, 0, len(all))
	for name, svc := range all {
		entry := model.ServiceHealthSample{Service: name, State: "unknown"}
		if p, ok := svc.(statusProvider); ok && p.Status() != nil {
			st := p.Status()
			entry.State = string(st.State())
			if err := st.LastError(); err != nil {
				entry.Error = err.Error()
			}
		}
		out = append(out, entry)
	}
	a.mu.Lock()
	for name, reason := range a.skipped {
		out = append(out, model.ServiceHealthSample{
			Service: name,
			State:   "apply_failed",
			Error:   reason,
		})
	}
	a.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Service < out[j].Service })
	return out
}

func (a *Applier) deleteKind(kind string, current, desired map[string]struct{}) {
	for name := range current {
		if _, ok := desired[name]; ok {
			continue
		}
		switch kind {
		case "services":
			registry.ServiceRegistry().Unregister(name) // Unregister closes services
		case "chains":
			registry.ChainRegistry().Unregister(name)
		case "quotas":
			registry.QuotaLimiterRegistry().Unregister(name)
		case "climiters":
			registry.ConnLimiterRegistry().Unregister(name)
		case "rlimiters":
			registry.RateLimiterRegistry().Unregister(name)
		case "limiters":
			registry.TrafficLimiterRegistry().Unregister(name)
		case "admissions":
			registry.AdmissionRegistry().Unregister(name)
		}
		a.log.Debug("GOST object deleted", "kind", kind, "name", name)
	}
}

// reconcileLimiters hot-swaps limiter objects: registering under an existing
// name is an error, so updates go through Unregister + Register.
func reconcileLimiters[T any](
	kind string,
	reg coregistry.Registry[T],
	parse func(*config.LimiterConfig) T,
	last, desired []*config.LimiterConfig,
	log *slog.Logger,
) error {
	for _, cfg := range desired {
		exists := reg.IsRegistered(cfg.Name)
		changed := exists && !containsEqual(last, cfg)
		if exists && !changed {
			continue
		}
		if changed {
			reg.Unregister(cfg.Name)
		}
		if err := reg.Register(cfg.Name, parse(cfg)); err != nil {
			return fmt.Errorf("register %s %q: %w", kind, cfg.Name, err)
		}
		if changed {
			log.Debug("GOST object updated", "kind", kind, "name", cfg.Name)
		} else {
			log.Debug("GOST object created", "kind", kind, "name", cfg.Name)
		}
	}
	return nil
}

// stagedChain is one parsed chain waiting to be registered (validation pass).
type stagedChain struct {
	cfg *config.ChainConfig
	ch  corechain.Chainer
}

// stageChains parses every desired chain that needs creating or updating.
// Pure validation: nothing is mutated, so an error here leaves the running
// state fully intact.
func (a *Applier) stageChains(last, desired []*config.ChainConfig) ([]stagedChain, error) {
	reg := registry.ChainRegistry()
	var staged []stagedChain
	for _, cfg := range desired {
		exists := reg.IsRegistered(cfg.Name)
		if exists && containsEqual(last, cfg) && !(a.forceTLS && tlsChain(cfg)) {
			continue // unchanged, leave the running chain alone
		}
		ch, err := chain_parser.ParseChain(cfg, corelogger.Default())
		if err != nil {
			return nil, fmt.Errorf("parse chains %q: %w", cfg.Name, err)
		}
		staged = append(staged, stagedChain{cfg: cfg, ch: ch})
	}
	return staged, nil
}

func (a *Applier) registerChains(staged []stagedChain) error {
	reg := registry.ChainRegistry()
	for _, s := range staged {
		if reg.IsRegistered(s.cfg.Name) {
			reg.Unregister(s.cfg.Name)
		}
		if err := reg.Register(s.cfg.Name, s.ch); err != nil {
			return fmt.Errorf("register chains %q: %w", s.cfg.Name, err)
		}
		a.log.Debug("GOST object updated", "kind", "chains", "name", s.cfg.Name)
	}
	return nil
}

// stagedAdmission is one parsed admission waiting to be registered.
type stagedAdmission struct {
	cfg *config.AdmissionConfig
	adm coreadmission.Admission
}

// stageAdmissions parses every desired admission needing create/update —
// part of the validation pass, before any mutation.
func (a *Applier) stageAdmissions(last, desired []*config.AdmissionConfig) ([]stagedAdmission, error) {
	reg := registry.AdmissionRegistry()
	var staged []stagedAdmission
	for _, cfg := range desired {
		exists := reg.IsRegistered(cfg.Name)
		if exists && containsEqual(last, cfg) {
			continue
		}
		// ParseAdmission returns nil admission for an unparseable matcher
		// list; an explicitly empty name/config would surface on first use.
		staged = append(staged, stagedAdmission{cfg: cfg, adm: admission_parser.ParseAdmission(cfg)})
	}
	return staged, nil
}

func (a *Applier) registerAdmissions(staged []stagedAdmission) error {
	reg := registry.AdmissionRegistry()
	for _, s := range staged {
		if reg.IsRegistered(s.cfg.Name) {
			reg.Unregister(s.cfg.Name)
		}
		if err := reg.Register(s.cfg.Name, s.adm); err != nil {
			return fmt.Errorf("register admissions %q: %w", s.cfg.Name, err)
		}
		a.log.Debug("GOST object updated", "kind", "admissions", "name", s.cfg.Name)
	}
	return nil
}

// reconcileQuotas hot-swaps traffic-quota objects (unlimited-time or windowed
// allowances). The listener-side wrapper resolves quotas by name on every
// Accept, so a swap takes effect immediately without touching services: a
// same-window change adjusts the threshold while keeping the accumulated
// counter; a changed window starts counting from zero. Deleting a quota makes
// it inert (fail-open) — removing the allowance entirely must go through
// removing the service from the config.
func (a *Applier) reconcileQuotas(last, desired []*config.QuotaConfig) error {
	reg := registry.QuotaLimiterRegistry()
	for _, cfg := range desired {
		exists := reg.IsRegistered(cfg.Name)
		changed := exists && !containsEqual(last, cfg)
		if exists && !changed {
			continue
		}
		if changed {
			reg.Unregister(cfg.Name) // closes the old limiter (fail-open mid-swap)
		}
		if err := reg.Register(cfg.Name, quota_parser.ParseQuotaLimiter(cfg)); err != nil {
			return fmt.Errorf("register quotas %q: %w", cfg.Name, err)
		}
		if changed {
			a.log.Debug("GOST object updated", "kind", "quotas", "name", cfg.Name)
		} else {
			a.log.Debug("GOST object created", "kind", "quotas", "name", cfg.Name)
		}
	}
	return nil
}

// isNormalServeExit reports whether a Serve error is merely the listener being
// closed underneath the accept loop — the normal exit for replaced/stopped
// services. Plain net listeners return net.ErrClosed; go-gost's custom
// transports (grpc/ws/quic/...) return their own listener.ErrClosed.
func isNormalServeExit(err error) bool {
	return errors.Is(err, net.ErrClosed) || errors.Is(err, corelistener.ErrClosed)
}

// isServiceDead reports whether a registered service's accept loop has exited
// permanently (x/service sets StateClosed only when Serve() returns with a
// non-temporary error). A dead service keeps its registry entry but forwards
// nothing until something rebuilds it.
func isServiceDead(svc coreservice.Service) bool {
	p, ok := svc.(statusProvider)
	if !ok || p.Status() == nil {
		return false
	}
	return p.Status().State() == xservice.StateClosed
}

// reconcileServices brings the service registry in line with desired. Unlike
// the other groups, a parse failure does not abort: the failed service is
// skipped (returned in the map, name -> reason) and everything else applies —
// one port conflict must not freeze the node's whole config. Unchanged
// services that have DIED since the last apply are force-rebuilt (self-heal:
// nothing else would restart them until the next config change).
func (a *Applier) reconcileServices(last, desired []*config.ServiceConfig) map[string]string {
	reg := registry.ServiceRegistry()
	var skipped map[string]string
	for _, cfg := range desired {
		exists := reg.IsRegistered(cfg.Name)
		dead := exists && isServiceDead(reg.Get(cfg.Name))
		materialSwapped := a.forceTLS && tlsService(cfg)
		changed := (exists && (!containsEqual(last, cfg) || materialSwapped)) || dead
		if exists && !changed {
			continue
		}
		if dead {
			a.log.Warn("GOST service died, rebuilding", "name", cfg.Name)
		} else if materialSwapped && containsEqual(last, cfg) {
			a.log.Info("TLS material changed, rebuilding TLS service", "name", cfg.Name)
		}
		if exists {
			old := reg.Get(cfg.Name)
			if old != nil {
				if err := old.Close(); err != nil {
					a.log.Warn("GOST service close failed", "name", cfg.Name, "error", err)
				}
			}
			reg.Unregister(cfg.Name)
		}
		svc, err := service_parser.ParseService(cfg)
		if err != nil {
			// Skip-and-continue: the rest of the config still applies; the
			// caller reports the skip and retries on the next poll, which
			// recovers transient causes (e.g. a port held by a dying process).
			if skipped == nil {
				skipped = make(map[string]string)
			}
			skipped[cfg.Name] = err.Error()
			a.log.Error("GOST service failed to apply, skipping", "name", cfg.Name, "error", err)
			continue
		}
		if err := reg.Register(cfg.Name, svc); err != nil {
			if skipped == nil {
				skipped = make(map[string]string)
			}
			skipped[cfg.Name] = err.Error()
			a.log.Error("GOST service failed to register, skipping", "name", cfg.Name, "error", err)
			continue
		}
		go func(name string) {
			if err := svc.Serve(); err != nil {
				if isNormalServeExit(err) {
					a.log.Debug("GOST service exited", "name", name)
					return
				}
				a.log.Error("GOST service serve failed", "name", name, "error", err)
			}
		}(cfg.Name)
		if changed && !dead {
			a.log.Debug("GOST object updated", "kind", "services", "name", cfg.Name)
		} else {
			a.log.Debug("GOST object created", "kind", "services", "name", cfg.Name)
		}
	}
	return skipped
}

// ---- helpers ----

func limiterNames(list []*config.LimiterConfig) []string {
	out := make([]string, len(list))
	for i, cfg := range list {
		out[i] = cfg.Name
	}
	return out
}

func chainNames(cfg *config.Config) []string {
	out := make([]string, len(cfg.Chains))
	for i, c := range cfg.Chains {
		out[i] = c.Name
	}
	return out
}

func quotaNames(cfg *config.Config) []string {
	out := make([]string, len(cfg.Quotas))
	for i, q := range cfg.Quotas {
		out[i] = q.Name
	}
	return out
}

func serviceNames(cfg *config.Config) []string {
	out := make([]string, len(cfg.Services))
	for i, s := range cfg.Services {
		out[i] = s.Name
	}
	return out
}

func admissionNames(cfg *config.Config) []string {
	out := make([]string, len(cfg.Admissions))
	for i, a := range cfg.Admissions {
		out[i] = a.Name
	}
	return out
}

func desiredSet(names []string) map[string]struct{} {
	set := make(map[string]struct{}, len(names))
	for _, n := range names {
		set[n] = struct{}{}
	}
	return set
}

func keySet[V any](all map[string]V) map[string]struct{} {
	set := make(map[string]struct{}, len(all))
	for name := range all {
		set[name] = struct{}{}
	}
	return set
}

// containsEqual reports whether last already contains an object deep-equal to
// desired (both sides are pointer element types, so DeepEqual follows them).
func containsEqual[T any](last []*T, desired *T) bool {
	for _, item := range last {
		if reflect.DeepEqual(item, desired) {
			return true
		}
	}
	return false
}
