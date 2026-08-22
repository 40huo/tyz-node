#!/usr/bin/env bash
# Local end-to-end test for the relay scenarios:
#   1. single-node direct forward (tunnel-1: entry :8080 -> example.com:80)
#   2. two-node relay with a shared exit port (tunnel-2: two entry services
#      :16535/:16548 -> node-2's single relay listener :16900 -> per-rule
#      targets). One exit port serves every rule of the tunnel because the
#      relay protocol carries each connection's destination in-band.
#   3. two-node RAW forward (tunnel-3): no relay protocol — each rule is a
#      dedicated tcp port pair (entry :16556/:16557 -> exit :26556/:26557).
#   4. two-node relay + TLS (tunnel-4): shared exit listener :16901 wrapped in
#      TLS1.3/h2 (grpc) with platform certs, mTLS + relay auth + entry-IP
#      admission — the censorship-evasion link shape.
#
# Prerequisites: bun, go, python3, and wrangler dev running on :8787 with the
# root .dev.vars + local seed applied. The script re-applies the seed,
# then builds the agent, starts two local HTTP targets and two agent
# processes, and asserts distinguishable responses through both entry ports.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
AGENT_BIN="$(mktemp -d)/tyz-agent"
WORK="$(mktemp -d)"
cd "$ROOT"

command -v python3 >/dev/null || { echo "SKIP: python3 required for local targets"; exit 1; }

echo "== re-applying local seed =="
(bunx wrangler d1 execute DB --local --file apps/server/scripts/seed-local.sql >/dev/null)

echo "== building agent =="
(cd apps/agent && CGO_ENABLED=0 go build -trimpath -o "$AGENT_BIN" .)

cleanup() {
  for pid in ${PIDS:-}; do kill "$pid" 2>/dev/null || true; done
  if [ -n "${FAILED:-}" ]; then cp -a "$WORK" /tmp/e2e-failed-logs 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
PIDS=""

start_agent() { # name token gost_api_port — DEBUG exposes the GOST web api used as the readiness probe
  local name="$1" token="$2" port="$3"
  mkdir -p "$WORK/$name"
  (cd "$WORK/$name" && exec env CONTROL_PLANE_URL=http://localhost:8787 NODE_TOKEN="$token" \
    DEBUG=true GOST_API_ADDR="127.0.0.1:$port" HOME="$WORK/$name" "$AGENT_BIN") >"$WORK/$name.log" 2>&1 &
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
for port in 18081 18082 16900 16901 16535 16548 16556 16557 16558 16559 26556 26557 19180 19181; do wait_port_free "$port"; done

echo "== starting local HTTP targets (19180/19181) =="
start_target target-one 19180
start_target target-two 19181

echo "== starting exit agent (node-2, dev-token-2) and entry agent (node-1, dev-token-1) =="
start_agent exit dev-token-2 18081
start_agent entry dev-token-1 18082

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

# The agent has no HTTP surface of its own — readiness is "the GOST debug api
# answers AND the applied config carries services" (DEBUG=true above).
wait_gost_config() { # gost_api_port timeout_s
  local port="$1" timeout="$2" waited=0
  until curl -sf -m 2 "http://127.0.0.1:$port/api/config" | grep -q '"service-'; do
    sleep 0.5
    waited=$((waited + 1))
    if [ "$waited" -ge $((timeout * 2)) ]; then
      return 1
    fi
  done
}

echo "== waiting for agents and listeners =="
wait_gost_config 18081 20 || { FAILED=1; echo "FAIL: exit agent config"; tail -5 "$WORK/exit.log"; exit 1; }
wait_gost_config 18082 20 || { FAILED=1; echo "FAIL: entry agent config"; tail -5 "$WORK/entry.log"; exit 1; }
for port in 16535 16548 16556 16557 16558 16559; do
  wait_http "http://127.0.0.1:$port/" 20 || { FAILED=1; echo "FAIL: entry :$port not listening"; tail -20 "$WORK/entry.log"; exit 1; }
done

echo "== assertions =="
body_one="$(curl -sf -m 8 http://127.0.0.1:16535/)"
body_two="$(curl -sf -m 8 http://127.0.0.1:16548/)"
[ "$body_one" = "target-one" ] || { FAILED=1; echo "FAIL: :16535 returned '$body_one', want 'target-one'"; exit 1; }
[ "$body_two" = "target-two" ] || { FAILED=1; echo "FAIL: :16548 returned '$body_two', want 'target-two'"; exit 1; }
echo "PASS: two-node relay — both entry rules reach distinct targets through the shared exit relay :16900"

# Raw forward (tunnel-3): the exit side runs one tcp service per rule on
# :26556/:26557; the entry forwards straight to those ports (no relay bytes).
raw_one="$(curl -sf -m 8 http://127.0.0.1:16556/)"
raw_two="$(curl -sf -m 8 http://127.0.0.1:16557/)"
[ "$raw_one" = "target-one" ] || { FAILED=1; echo "FAIL: raw :16556 returned '$raw_one', want 'target-one'"; exit 1; }
[ "$raw_two" = "target-two" ] || { FAILED=1; echo "FAIL: raw :16557 returned '$raw_two', want 'target-two'"; exit 1; }
ss -ltn 'sport = :26556' | grep -q LISTEN || { FAILED=1; echo "FAIL: raw exit :26556 not listening"; exit 1; }
echo "PASS: raw forward — per-rule port pairs 16556->26556 / 16557->26557 (no relay protocol)"

# Relay + TLS (tunnel-4): grpc/TLS1.3/h2 shared exit listener :16901 with
# platform certs, mTLS, relay auth and admission. A plain-TCP probe must be
# rejected (TLS required), the real entry path must return the targets.
tls_one="$(curl -sf -m 10 http://127.0.0.1:16558/)"
tls_two="$(curl -sf -m 10 http://127.0.0.1:16559/)"
[ "$tls_one" = "target-one" ] || { FAILED=1; echo "FAIL: tls :16558 returned '$tls_one', want 'target-one'"; exit 1; }
[ "$tls_two" = "target-two" ] || { FAILED=1; echo "FAIL: tls :16559 returned '$tls_two', want 'target-two'"; exit 1; }
if printf 'GET / HTTP/1.0\r\n\r\n' | timeout 3 python3 -c '
import socket, sys
s = socket.create_connection(("127.0.0.1", 16901), timeout=2)
s.sendall(sys.stdin.buffer.read())
try:
    data = s.recv(64)
except OSError:
    sys.exit(0)  # connection reset also proves plaintext is refused
sys.exit(0 if not data.startswith(b"HTTP") else 1)
'; then
  echo "PASS: relay+TLS — plaintext probe on :16901 refused, entry rules flow over the TLS link"
else
  FAILED=1; echo "FAIL: :16901 answered plaintext HTTP (TLS not enforced?)"; exit 1
fi

single="$(curl -sf -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
if [ "$single" != "000" ]; then
  echo "PASS: single-node direct forward — :8080 reachable via tunnel (HTTP $single)"
else
  echo "WARN: single-node forward :8080 unreachable (needs internet for example.com)"
fi

echo "ALL CHECKS PASSED (agent logs under $WORK)"
