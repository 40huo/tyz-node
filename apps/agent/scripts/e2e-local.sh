#!/usr/bin/env bash
# Local end-to-end test for the two relay scenarios:
#   1. single-node direct forward (tunnel-1: entry :8080 -> example.com:80)
#   2. two-node relay with a shared exit port (tunnel-2: two entry services
#      :16535/:16548 -> node-2's single relay listener :16900 -> per-rule
#      targets). One exit port serves every rule of the tunnel because the
#      relay protocol carries each connection's destination in-band.
#
# Prerequisites: bun, go, python3, and wrangler dev running on :8787 with the
# apps/server .dev.vars + local seed applied. The script re-applies the seed,
# then builds the agent, starts two local HTTP targets and two agent
# processes, and asserts distinguishable responses through both entry ports.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
AGENT_BIN="$(mktemp -d)/tyz-agent"
WORK="$(mktemp -d)"
cd "$ROOT"

command -v python3 >/dev/null || { echo "SKIP: python3 required for local targets"; exit 1; }

echo "== re-applying local seed =="
(cd apps/server && bunx wrangler d1 execute DB --local --file scripts/seed-local.sql >/dev/null)

echo "== building agent =="
(cd apps/agent && CGO_ENABLED=0 go build -trimpath -o "$AGENT_BIN" .)

cleanup() {
  for pid in ${PIDS:-}; do kill "$pid" 2>/dev/null || true; done
  if [ -n "${FAILED:-}" ]; then cp -a "$WORK" /tmp/e2e-failed-logs 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
PIDS=""

start_agent() { # name token health_port
  local name="$1" token="$2" port="$3"
  mkdir -p "$WORK/$name"
  (cd "$WORK/$name" && exec env CONTROL_PLANE_URL=http://localhost:8787 NODE_TOKEN="$token" \
    PORT="$port" HOST=127.0.0.1 HOME="$WORK/$name" "$AGENT_BIN") >"$WORK/$name.log" 2>&1 &
  PIDS="$PIDS $!"
}

start_target() { # name port
  local name="$1" port="$2"
  mkdir -p "$WORK/$name"
  printf '%s' "$name" > "$WORK/$name/index.html"
  (cd "$WORK/$name" && exec python3 -m http.server "$port" --bind 127.0.0.1) >/dev/null 2>&1 &
  PIDS="$PIDS $!"
}

# Wait until a TCP port is free again (agents drain for up to 10s on SIGTERM).
wait_port_free() { # port
  for _ in $(seq 1 40); do
    ss -ltn "sport = :$1" | grep -q LISTEN || return 0
    sleep 0.5
  done
  echo "WARN: port $1 still occupied"
}

echo "== cleaning up leftovers from previous runs =="
pkill -x tyz-agent 2>/dev/null || true
pkill -f "http.server 191[0-9][0-9]" 2>/dev/null || true
for port in 18091 18092 16900 16535 16548 19180 19181; do wait_port_free "$port"; done

echo "== starting local HTTP targets (19180/19181) =="
start_target target-one 19180
start_target target-two 19181

echo "== starting exit agent (node-2, dev-token-2) and entry agent (node-1, dev-token-1) =="
start_agent exit dev-token-2 18092
start_agent entry dev-token-1 18091

wait_http() { # url timeout_s
  local url="$1" timeout="$2" waited=0
  until curl -sf -m 2 -o /dev/null "$url"; do
    sleep 0.5
    waited=$((waited + 1))
    if [ "$waited" -ge $((timeout * 2)) ]; then
      return 1
    fi
  done
}

echo "== waiting for agents and listeners =="
wait_http http://127.0.0.1:18092/healthz 20 || { FAILED=1; echo "FAIL: exit agent health"; tail -5 "$WORK/exit.log"; exit 1; }
wait_http http://127.0.0.1:18091/healthz 20 || { FAILED=1; echo "FAIL: entry agent health"; tail -5 "$WORK/entry.log"; exit 1; }
wait_http http://127.0.0.1:16535/ 20 || { FAILED=1; echo "FAIL: entry :16535 not listening"; tail -20 "$WORK/entry.log"; exit 1; }
wait_http http://127.0.0.1:16548/ 20 || { FAILED=1; echo "FAIL: entry :16548 not listening"; tail -20 "$WORK/entry.log"; exit 1; }

echo "== assertions =="
body_one="$(curl -sf -m 8 http://127.0.0.1:16535/)"
body_two="$(curl -sf -m 8 http://127.0.0.1:16548/)"
[ "$body_one" = "target-one" ] || { FAILED=1; echo "FAIL: :16535 returned '$body_one', want 'target-one'"; exit 1; }
[ "$body_two" = "target-two" ] || { FAILED=1; echo "FAIL: :16548 returned '$body_two', want 'target-two'"; exit 1; }
echo "PASS: two-node relay — both entry rules reach distinct targets through the shared exit relay :16900"

single="$(curl -sf -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
if [ "$single" != "000" ]; then
  echo "PASS: single-node direct forward — :8080 reachable via tunnel (HTTP $single)"
else
  echo "WARN: single-node forward :8080 unreachable (needs internet for example.com)"
fi

echo "ALL CHECKS PASSED (agent logs under $WORK)"
