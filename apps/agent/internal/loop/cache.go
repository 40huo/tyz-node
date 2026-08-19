package loop

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/laoshan-tech/tyz-node/apps/agent/internal/model"
)

// The local config cache lets the agent start serving tunnels when the
// control plane is unreachable: the last successfully applied config is
// persisted in the control-plane response shape (version + NodeConfigData),
// re-applied at boot, and its version becomes the polling baseline — an
// unchanged config then costs a single 304 instead of a full transfer.

// loadConfigCache reads the persisted last-applied config.
func loadConfigCache(path string) (*model.AgentConfigResponse, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cached model.AgentConfigResponse
	if err := json.Unmarshal(raw, &cached); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return &cached, nil
}

// saveConfigCache atomically persists the config (write temp + fsync +
// rename) so a crash or power loss mid-write can never leave a truncated or
// empty file behind.
func saveConfigCache(path string, resp *model.AgentConfigResponse) error {
	raw, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close() //nolint:errcheck
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close() //nolint:errcheck
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// bootstrapFromCache applies the cached config before the poll loop starts.
// Best effort: any problem is logged and skipped — the loop will retry the
// control plane with its normal backoff.
func (l *Loop) bootstrapFromCache() {
	if l.opts.CachePath == "" {
		return
	}
	cached, err := loadConfigCache(l.opts.CachePath)
	if err != nil {
		if !os.IsNotExist(err) {
			l.log.Warn("Config cache unreadable, starting empty", "path", l.opts.CachePath, "error", err)
		}
		return
	}
	if err := l.opts.Apply(&cached.Config); err != nil {
		l.log.Warn("Config cache apply failed, starting empty", "error", err)
		return
	}
	l.configVersion = cached.Version
	l.log.Info("Bootstrapped from cached config",
		"version", cached.Version,
		"services", len(cached.Config.Rules))
}

// saveCache persists the just-applied config (best effort).
func (l *Loop) saveCache(resp *model.AgentConfigResponse) {
	if l.opts.CachePath == "" {
		return
	}
	if err := saveConfigCache(l.opts.CachePath, resp); err != nil {
		l.log.Warn("Config cache write failed", "error", err)
	}
}
