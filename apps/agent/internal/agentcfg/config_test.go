package agentcfg

import (
	"os"
	"os/exec"
	"testing"
)

// TestLoadRequiresCoreEnv pins the required-variable check.
func TestLoadRequiresCoreEnv(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "")
	t.Setenv("NODE_TOKEN", "")
	if _, err := Load(); err == nil {
		t.Fatal("Load must fail without CONTROL_PLANE_URL/NODE_TOKEN")
	}
}

// TestEnvIntFailsLoudly pins the strict integer check: a malformed value
// exits the process instead of silently falling back to the default (the
// typo would otherwise run the agent at unexpected cadences).
func TestEnvIntFailsLoudly(t *testing.T) {
	if os.Getenv("BE_TEST_BAD_INT") == "1" {
		t.Setenv("POLL_INTERVAL_MS", "1O000") // letter O, not zero
		Load()                                // must not return
		os.Exit(1)                            // unreachable when correct
	}
	cmd := exec.Command(os.Args[0], "-test.run", "TestEnvIntFailsLoudly")
	cmd.Env = append(os.Environ(), "BE_TEST_BAD_INT=1", "CONTROL_PLANE_URL=http://x", "NODE_TOKEN=t")
	err := cmd.Run()
	if err == nil {
		t.Fatal("Load must exit non-zero on a malformed integer env var")
	}
}
