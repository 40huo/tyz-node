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
	ControlPlaneURL string
	NodeToken       string

	PollInterval       time.Duration
	StatsFlushInterval time.Duration

	WSenabled       bool
	WSProbeInterval time.Duration
	WSPingInterval  time.Duration

	// Debug enables verbose logging and starts the embedded GOST Web API
	// (a read-write debug surface for inspecting the actually-applied GOST
	// config). Test-only.
	Debug bool

	// GostAPIAddr is the GOST Web API listen address, effective only when
	// Debug is on (e.g. "127.0.0.1:18080"; the main binary substitutes a
	// default when empty). Configurable so a port conflict can be avoided.
	GostAPIAddr string
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
		ControlPlaneURL:    strings.TrimRight(os.Getenv("CONTROL_PLANE_URL"), "/"),
		NodeToken:          os.Getenv("NODE_TOKEN"),
		PollInterval:       time.Duration(envInt("POLL_INTERVAL_MS", 10000)) * time.Millisecond,
		StatsFlushInterval: time.Duration(envInt("STATS_FLUSH_INTERVAL_MS", 60000)) * time.Millisecond,
		WSenabled:          strings.ToLower(os.Getenv("WS_ENABLED")) != "false",
		WSProbeInterval:    time.Duration(envInt("WS_PROBE_INTERVAL_MS", 60000)) * time.Millisecond,
		WSPingInterval:     time.Duration(envInt("WS_PING_INTERVAL_MS", 60000)) * time.Millisecond,
		Debug:              os.Getenv("DEBUG") == "true",
		GostAPIAddr:        os.Getenv("GOST_API_ADDR"),
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

// envInt parses an integer env var. A set-but-malformed value is an ERROR,
// not a silent fallback — a typo like POLL_INTERVAL_MS=1O000 (letter O) must
// fail loudly at startup instead of quietly running at the default.
func envInt(name string, fallback int) int {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid %s=%q: not an integer\n", name, v)
		os.Exit(1)
	}
	return n
}
