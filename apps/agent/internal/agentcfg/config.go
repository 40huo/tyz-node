// Package agentcfg loads agent configuration from a .env file (if present)
// and the process environment. Variables already set in the environment win
// over .env values, matching the previous Bun agent's dotenv behavior.
package agentcfg

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// Health endpoint (GET /healthz).
	Host string
	Port int

	ControlPlaneURL string
	NodeToken       string

	PollInterval       time.Duration
	StatsFlushInterval time.Duration

	WSenabled       bool
	WSProbeInterval time.Duration
	WSPingInterval  time.Duration

	// GostAPIAddr optionally exposes the embedded GOST Web API for debugging
	// (e.g. "127.0.0.1:18080"). Empty by default.
	GostAPIAddr string

	Debug bool
}

// Load reads ./.env when present, then resolves configuration from env vars.
func Load() (*Config, error) {
	loadDotEnv(".env")

	for _, name := range []string{"CONTROL_PLANE_URL", "NODE_TOKEN"} {
		if os.Getenv(name) == "" {
			return nil, fmt.Errorf("missing required environment variable: %s", name)
		}
	}

	cfg := &Config{
		Host:               envStr("HOST", "127.0.0.1"),
		Port:               envInt("PORT", 18090),
		ControlPlaneURL:    strings.TrimRight(os.Getenv("CONTROL_PLANE_URL"), "/"),
		NodeToken:          os.Getenv("NODE_TOKEN"),
		PollInterval:       time.Duration(envInt("POLL_INTERVAL_MS", 10000)) * time.Millisecond,
		StatsFlushInterval: time.Duration(envInt("STATS_FLUSH_INTERVAL_MS", 60000)) * time.Millisecond,
		WSenabled:          strings.ToLower(os.Getenv("WS_ENABLED")) != "false",
		WSProbeInterval:    time.Duration(envInt("WS_PROBE_INTERVAL_MS", 60000)) * time.Millisecond,
		WSPingInterval:     time.Duration(envInt("WS_PING_INTERVAL_MS", 60000)) * time.Millisecond,
		GostAPIAddr:        os.Getenv("GOST_API_ADDR"),
		Debug:              os.Getenv("DEBUG") == "true",
	}

	intervalKeys := []struct {
		name  string
		value time.Duration
	}{
		{"POLL_INTERVAL_MS", cfg.PollInterval},
		{"STATS_FLUSH_INTERVAL_MS", cfg.StatsFlushInterval},
		{"WS_PROBE_INTERVAL_MS", cfg.WSProbeInterval},
		{"WS_PING_INTERVAL_MS", cfg.WSPingInterval},
	}
	for _, kv := range intervalKeys {
		if kv.value <= 0 {
			return nil, fmt.Errorf("%s must be a positive integer", kv.name)
		}
	}

	return cfg, nil
}

func loadDotEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key != "" {
			// The real environment takes precedence over .env.
			if _, exists := os.LookupEnv(key); !exists {
				os.Setenv(key, value)
			}
		}
	}
}

func envStr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
