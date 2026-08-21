// Package model mirrors the @tyz/shared entities delivered by the control
// plane (GET /api/agent/config). Only the fields the agent actually consumes
// are declared; unknown JSON fields are ignored.
package model

import "encoding/json"

type ChainType string

const (
	ChainIn    ChainType = "in"
	ChainChain ChainType = "chain"
	ChainOut   ChainType = "out"
)

type Transport string

const (
	TransportRaw  Transport = "raw"
	TransportWS   Transport = "ws"
	TransportTLS  Transport = "tls"
	TransportGRPC Transport = "grpc"
	TransportWSS  Transport = "wss"
	TransportMTLS Transport = "mtls"
	TransportMWSS Transport = "mwss"
)

// ForwardMode selects how a two-node tunnel forwards traffic. Relay (default)
// multiplexes every rule over one relay-protocol listener on the exit node;
// Raw gives each rule a dedicated tcp/tcp port pair with no custom protocol
// header on the wire.
type ForwardMode string

const (
	ForwardModeRelay ForwardMode = "relay"
	ForwardModeRaw   ForwardMode = "raw"
)

// TlsConfig carries the auto-certificate hints from the control plane.
type TlsConfig struct {
	CommonName   *string `json:"commonName,omitempty"`
	Organization *string `json:"organization,omitempty"`
}

type RelayNode struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Address string `json:"address"`
	Ports   string `json:"ports"` // e.g. "10000-20000"
}

type Tunnel struct {
	ID int `json:"id"`
	// ingress_display_address is a client-facing display field (shown in the
	// admin panel); it never takes part in GOST config generation.
	// Newer fields are optional-tolerant: legacy cached payloads (offline
	// bootstrap replays last-config.json through the current builder) lack
	// them entirely; the zero values mean "relay, no TLS, no link auth".
	ForwardMode   ForwardMode `json:"forward_mode,omitempty"`
	TLSEnabled    bool        `json:"tls_enabled,omitempty"`
	RelayAuthUser string      `json:"relay_auth_user,omitempty"`
	RelayAuthPass string      `json:"relay_auth_pass,omitempty"`
}

// TLSMaterial is the platform-issued link TLS material (PEM text). Present
// only when at least one of the node's tunnels enables TLS; the agent writes
// it to its certs directory and the generated GOST config references the
// files (mutual TLS: exits serve the server cert and verify clients against
// the CA, entries present the client cert and verify the exit).
type TLSMaterial struct {
	SNI        string `json:"sni"`
	CACert     string `json:"ca_cert"`
	ServerCert string `json:"server_cert"`
	ServerKey  string `json:"server_key"`
	ClientCert string `json:"client_cert"`
	ClientKey  string `json:"client_key"`
}

type Chain struct {
	ID        int       `json:"id"`
	TunnelID  int       `json:"tunnel_id"`
	NodeID    int       `json:"node_id"`
	ChainType ChainType `json:"chain_type"`
	Transport Transport `json:"transport"`
	Index     int       `json:"index"`
	Strategy  string    `json:"strategy"`
	Port      int       `json:"port"` // 0 = auto-allocate
}

type RelayRule struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	ListenPort int    `json:"listen_port"`
	TunnelID   *int   `json:"tunnel_id"` // nil = not deployed anywhere
	Targets    string `json:"targets"`
	Status     string `json:"status"`
	// ExitPort is the rule's dedicated port on the exit node (raw-mode
	// tunnels). 0 = auto-allocate from the exit node's port range with the
	// same deterministic formula the entry uses to dial it. Absent in legacy
	// payloads.
	ExitPort int `json:"exit_port,omitempty"`
	// Quota is the traffic allowance computed by the control plane; nil = none.
	// (user_id is intentionally not modeled — the agent only consumes the
	// derived quota, and legacy payloads carry it as a string.)
	Quota *RuleQuota `json:"quota,omitempty"`
	// Limit is kept raw: the stored value may be an object or a legacy JSON string.
	Limit json.RawMessage `json:"limit,omitempty"`
}

// RuleQuota carries a traffic allowance shared by every rule referencing the
// same quota name (GOST quotas with the same name share one counter — the
// control plane emits per-user names). LimitBytes is the REMAINING allowance
// at push time; the agent-side quota counter starts from zero when the object
// is (re)created, so the effective gate is pre-push usage (server ledger) +
// post-push usage (agent counter). StartsAt/ExpiresAt are RFC3339 and define
// the billing window — a changed window resets the counter (换购清零). An
// empty ExpiresAt means a permanent package.
type RuleQuota struct {
	Name       string `json:"name"`
	LimitBytes uint64 `json:"limit_bytes"`
	StartsAt   string `json:"starts_at"`
	ExpiresAt  string `json:"expires_at,omitempty"`
}

// NodeConfigData is the aggregated payload for one relay node.
type NodeConfigData struct {
	Node RelayNode `json:"node"`
	// Nodes carries the records of every node the chains reference (incl. the
	// recipient) so each hop's dial address resolves from its own node record.
	// Absent in legacy payloads; callers fall back to Node.
	Nodes   []RelayNode `json:"nodes,omitempty"`
	Rules   []RelayRule `json:"rules"`
	Tunnels []Tunnel    `json:"tunnels"`
	Chains  []Chain     `json:"chains"`
	TLS     *TlsConfig  `json:"tls,omitempty"`
	// TLSMaterial is present only when a tunnel of this node enables link TLS.
	TLSMaterial *TLSMaterial `json:"tls_material,omitempty"`
}

// AgentConfigResponse is the body of a 200 from GET /api/agent/config.
type AgentConfigResponse struct {
	Version int64          `json:"version"`
	Config  NodeConfigData `json:"config"`
}

// ServiceHealthSample is the runtime state of one GOST service, uploaded
// alongside stats batches (states mirror x/service.State: running|ready|failed|closed).
type ServiceHealthSample struct {
	Service string `json:"service"`
	State   string `json:"state"`
	Error   string `json:"error,omitempty"`
}

// GostStatsSample is one flattened observer sample uploaded in batches.
type GostStatsSample struct {
	Service      string `json:"service"`
	Client       string `json:"client,omitempty"`
	TotalConns   uint64 `json:"totalConns"`
	CurrentConns uint64 `json:"currentConns"`
	InputBytes   uint64 `json:"inputBytes"`
	OutputBytes  uint64 `json:"outputBytes"`
	TotalErrs    uint64 `json:"totalErrs"`
}
