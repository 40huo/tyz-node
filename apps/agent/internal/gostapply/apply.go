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
	"sync"

	coregistry "github.com/go-gost/core/registry"
	"github.com/go-gost/x/config"
	chain_parser "github.com/go-gost/x/config/parsing/chain"
	limiter_parser "github.com/go-gost/x/config/parsing/limiter"
	service_parser "github.com/go-gost/x/config/parsing/service"
	"github.com/go-gost/x/registry"
)

type Applier struct {
	log  *slog.Logger
	mu   sync.Mutex
	last *config.Config
}

func New(log *slog.Logger) *Applier {
	return &Applier{log: log}
}

// Apply diffs desired against the running registries and mutates them.
func (a *Applier) Apply(desired *config.Config) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	var last *config.Config
	if a.last != nil {
		last = a.last
	} else {
		last = &config.Config{}
	}

	// Delete phase, top-down.
	a.deleteKind("services", keySet(registry.ServiceRegistry().GetAll()), desiredSet(serviceNames(desired)))
	a.deleteKind("chains", keySet(registry.ChainRegistry().GetAll()), desiredSet(chainNames(desired)))
	a.deleteKind("climiters", keySet(registry.ConnLimiterRegistry().GetAll()), desiredSet(limiterNames(desired.CLimiters)))
	a.deleteKind("rlimiters", keySet(registry.RateLimiterRegistry().GetAll()), desiredSet(limiterNames(desired.RLimiters)))
	a.deleteKind("limiters", keySet(registry.TrafficLimiterRegistry().GetAll()), desiredSet(limiterNames(desired.Limiters)))

	// Create/update phase, bottom-up.
	if err := reconcileLimiters("limiters", registry.TrafficLimiterRegistry(), limiter_parser.ParseTrafficLimiter, last.Limiters, desired.Limiters, a.log); err != nil {
		return err
	}
	if err := reconcileLimiters("rlimiters", registry.RateLimiterRegistry(), limiter_parser.ParseRateLimiter, last.RLimiters, desired.RLimiters, a.log); err != nil {
		return err
	}
	if err := reconcileLimiters("climiters", registry.ConnLimiterRegistry(), limiter_parser.ParseConnLimiter, last.CLimiters, desired.CLimiters, a.log); err != nil {
		return err
	}
	if err := a.reconcileChains(last.Chains, desired.Chains); err != nil {
		return err
	}
	if err := a.reconcileServices(last.Services, desired.Services); err != nil {
		return err
	}

	a.last = desired
	a.log.Info("GOST config synced",
		"services", len(desired.Services), "chains", len(desired.Chains))
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
		case "climiters":
			registry.ConnLimiterRegistry().Unregister(name)
		case "rlimiters":
			registry.RateLimiterRegistry().Unregister(name)
		case "limiters":
			registry.TrafficLimiterRegistry().Unregister(name)
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

func (a *Applier) reconcileChains(last, desired []*config.ChainConfig) error {
	reg := registry.ChainRegistry()
	for _, cfg := range desired {
		exists := reg.IsRegistered(cfg.Name)
		changed := exists && !containsEqual(last, cfg)
		if exists && !changed {
			continue
		}
		ch, err := chain_parser.ParseChain(cfg, nil)
		if err != nil {
			return fmt.Errorf("parse chains %q: %w", cfg.Name, err)
		}
		if changed {
			reg.Unregister(cfg.Name)
		}
		if err := reg.Register(cfg.Name, ch); err != nil {
			return fmt.Errorf("register chains %q: %w", cfg.Name, err)
		}
		if changed {
			a.log.Debug("GOST object updated", "kind", "chains", "name", cfg.Name)
		} else {
			a.log.Debug("GOST object created", "kind", "chains", "name", cfg.Name)
		}
	}
	return nil
}

func (a *Applier) reconcileServices(last, desired []*config.ServiceConfig) error {
	reg := registry.ServiceRegistry()
	for _, cfg := range desired {
		exists := reg.IsRegistered(cfg.Name)
		changed := exists && !containsEqual(last, cfg)
		if exists && !changed {
			continue
		}
		if changed {
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
			return fmt.Errorf("parse services %q: %w", cfg.Name, err)
		}
		if err := reg.Register(cfg.Name, svc); err != nil {
			return fmt.Errorf("register services %q: %w", cfg.Name, err)
		}
		go func(name string) {
			if err := svc.Serve(); err != nil {
				// A closed listener is the normal exit for replaced/stopped services.
				if errors.Is(err, net.ErrClosed) {
					a.log.Debug("GOST service exited", "name", name)
					return
				}
				a.log.Error("GOST service serve failed", "name", name, "error", err)
			}
		}(cfg.Name)
		if changed {
			a.log.Debug("GOST object updated", "kind", "services", "name", cfg.Name)
		} else {
			a.log.Debug("GOST object created", "kind", "services", "name", cfg.Name)
		}
	}
	return nil
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

func serviceNames(cfg *config.Config) []string {
	out := make([]string, len(cfg.Services))
	for i, s := range cfg.Services {
		out[i] = s.Name
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
