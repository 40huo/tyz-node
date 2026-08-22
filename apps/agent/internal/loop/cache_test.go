package loop

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
)

func testResp() *model.AgentConfigResponse {
	return &model.AgentConfigResponse{
		Version: 42,
		Config: model.NodeConfigData{
			Node:  model.RelayNode{ID: 1, Address: "127.0.0.1", Ports: "40000-40010"},
			Rules: []model.RelayRule{{ID: 1, ListenPort: 48001, Targets: "example.com:80"}},
		},
	}
}

func TestConfigCacheRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "last-config.json")

	if _, err := loadConfigCache(path); !os.IsNotExist(err) {
		t.Fatalf("missing cache: err = %v, want not-exist", err)
	}

	if err := saveConfigCache(path, testResp()); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("temp file left behind after save")
	}

	got, err := loadConfigCache(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got.Version != 42 || len(got.Config.Rules) != 1 || got.Config.Rules[0].ListenPort != 48001 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}

	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfigCache(path); err == nil {
		t.Fatal("corrupt cache should fail to load")
	}
}

func TestBootstrapFromCache(t *testing.T) {
	path := filepath.Join(t.TempDir(), "last-config.json")
	if err := saveConfigCache(path, testResp()); err != nil {
		t.Fatal(err)
	}

	applied := 0
	l := New(nil, Options{
		CachePath: path,
		Apply: func(_ *model.NodeConfigData) error {
			applied++
			return nil
		},
	}, slog.New(slog.NewTextHandler(&discardLog{}, nil)))

	l.bootstrapFromCache()
	if applied != 1 {
		t.Fatalf("applied = %d, want 1", applied)
	}
	if l.configVersion != 42 {
		t.Fatalf("configVersion = %d, want 42 (304 baseline)", l.configVersion)
	}
}

func TestBootstrapFromCacheToleratesErrors(t *testing.T) {
	dir := t.TempDir()

	// Missing cache: no apply, version stays 0.
	l := New(nil, Options{
		CachePath: filepath.Join(dir, "absent.json"),
		Apply:     func(_ *model.NodeConfigData) error { t.Fatal("must not apply"); return nil },
	}, slog.New(slog.NewTextHandler(&discardLog{}, nil)))
	l.bootstrapFromCache()
	if l.configVersion != 0 {
		t.Fatalf("version = %d, want 0", l.configVersion)
	}

	// Apply failure (e.g. stale cache with unparseable data): version stays 0
	// so the poll loop re-fetches from scratch.
	path := filepath.Join(dir, "stale.json")
	if err := saveConfigCache(path, testResp()); err != nil {
		t.Fatal(err)
	}
	l2 := New(nil, Options{
		CachePath: path,
		Apply:     func(_ *model.NodeConfigData) error { return errors.New("boom") },
	}, slog.New(slog.NewTextHandler(&discardLog{}, nil)))
	l2.bootstrapFromCache()
	if l2.configVersion != 0 {
		t.Fatalf("version = %d, want 0 after failed apply", l2.configVersion)
	}
}

type discardLog struct{}

func (discardLog) Write(p []byte) (int, error) { return len(p), nil }
