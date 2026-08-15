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
	ID                    int     `json:"id"`
	IngressDisplayAddress *string `json:"ingress_display_address,omitempty"`
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
	// Limit is kept raw: the stored value may be an object or a legacy JSON string.
	Limit json.RawMessage `json:"limit,omitempty"`
}

// NodeConfigData is the aggregated payload for one relay node.
type NodeConfigData struct {
	Node    RelayNode   `json:"node"`
	Rules   []RelayRule `json:"rules"`
	Tunnels []Tunnel    `json:"tunnels"`
	Chains  []Chain     `json:"chains"`
	TLS     *TlsConfig  `json:"tls,omitempty"`
}

// AgentConfigResponse is the body of a 200 from GET /api/agent/config.
type AgentConfigResponse struct {
	Version int64          `json:"version"`
	Config  NodeConfigData `json:"config"`
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
