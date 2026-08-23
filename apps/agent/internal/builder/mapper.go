package builder

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
)

// dialerType maps an internal transport to a GOST dialer/listener type. When
// the link carries platform TLS the WebSocket transports must use their
// native TLS types: gost's "ws"/"mws" listeners ignore configured TLS
// material (plaintextListeners in x/config/parsing/service) and would silently
// stay plaintext; "wss"/"mwss" terminate TLS themselves.
func dialerType(t model.Transport, tls bool) string {
	switch t {
	case model.TransportRaw:
		return "tcp"
	case model.TransportWS:
		return "ws"
	case model.TransportWSS:
		if tls {
			return "wss"
		}
		return "ws"
	case model.TransportTLS:
		return "tls"
	case model.TransportGRPC:
		return "grpc"
	case model.TransportMTLS:
		return "mtls"
	case model.TransportMWSS:
		if tls {
			return "mwss"
		}
		return "mws"
	default:
		return "tcp"
	}
}

// connectorType maps a chain position to a GOST connector type.
func connectorType(t model.ChainType) string {
	switch t {
	case model.ChainIn, model.ChainOut:
		return "forward"
	case model.ChainChain:
		return "relay"
	default:
		return "forward"
	}
}

// parsePortRange parses a "10000-20000" style range string.
func parsePortRange(ports string) (start, end int, err error) {
	if ports == "" || !strings.Contains(ports, "-") {
		return 0, 0, fmt.Errorf("invalid port range format: %s", ports)
	}
	parts := strings.SplitN(ports, "-", 2)
	start, err = strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("port range must be integers: %s", ports)
	}
	end, err = strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, fmt.Errorf("port range must be integers: %s", ports)
	}
	if start < 1 || start > 65535 || end < 1 || end > 65535 {
		return 0, 0, fmt.Errorf("port range must be 1-65535: %s", ports)
	}
	if start > end {
		return 0, 0, fmt.Errorf("start port must be <= end port: %s", ports)
	}
	return start, end, nil
}

// allocatePortForChain deterministically maps a chain to a port inside the
// node's port range: start + ((chainID + nodeID) % range). Same hash-based
// allocation as the original implementation.
func allocatePortForChain(nodePorts string, chainID, nodeID int) (int, error) {
	start, end, err := parsePortRange(nodePorts)
	if err != nil {
		return 0, err
	}
	return start + (chainID+nodeID)%(end-start+1), nil
}

// allocatePortForRule maps a raw-mode rule to its dedicated exit port inside
// the node's port range: start + ((ruleID*31 + nodeID) % range). The ruleID
// multiplier keeps raw-rule allocations from aliasing chain allocations
// (which hash chainID + nodeID) for small IDs. Deterministic on both ends:
// the exit listens on it, the entry dials it — no coordination needed.
// Collisions with other allocations surface as apply_failed service health.
func allocatePortForRule(nodePorts string, ruleID, nodeID int) (int, error) {
	start, end, err := parsePortRange(nodePorts)
	if err != nil {
		return 0, err
	}
	return start + (ruleID*31+nodeID)%(end-start+1), nil
}
