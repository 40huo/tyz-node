// Package builder renders a control-plane NodeConfigData into a GOST
// *config.Config, ported 1:1 from the previous TypeScript agent.
//
// Service/chain shapes by node position (chain_type, hop count):
//   - entry node (has an IN chain): listen on the rule port; 1 hop → plain
//     tcp forward, 2 hops → handler tcp + chain, 3+ hops → handler auto + chain
//   - exit/relay node: handler relay, listener derived from the OUT transport
//
// Chains are only generated at entry nodes. All object names are deterministic
// so the registry diff-apply recognizes stale objects across config versions.
package builder

import (
	"fmt"
	"sort"
	"time"

	"github.com/go-gost/x/config"
	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
)

// ObserverName is the name the in-process stats observer is registered under;
// GOST only reports stats for services that reference an observer.
const ObserverName = "stats-observer"

const (
	defaultCertValidity = 8760 * time.Hour // 1 year
	defaultCommonName   = "relay.gost.com"
	defaultOrganization = "GOSTCOM"
)

func defaultSelector(strategy string) *config.SelectorConfig {
	return &config.SelectorConfig{
		Strategy:    strategy,
		MaxFails:    1,
		FailTimeout: 30 * time.Second,
	}
}

// DefaultTLS returns the auto-certificate parameters for the node's global
// default certificate (consumed by parsing.BuildDefaultTLSConfig). The
// per-node tls hint emitted by the old agent never existed in GOST's schema
// (NodeConfig.tls has no validity/commonName fields) — this is where those
// parameters actually take effect.
func DefaultTLS(tls *model.TlsConfig) *config.TLSConfig {
	cn, org := defaultCommonName, defaultOrganization
	if tls != nil {
		if tls.CommonName != nil && *tls.CommonName != "" {
			cn = *tls.CommonName
		}
		if tls.Organization != nil && *tls.Organization != "" {
			org = *tls.Organization
		}
	}
	return &config.TLSConfig{
		Validity:     defaultCertValidity,
		CommonName:   cn,
		Organization: org,
	}
}

// Build generates the complete GOST configuration for one node.
func Build(data *model.NodeConfigData) (*config.Config, error) {
	b := &cfgBuilder{data: data}
	if err := b.buildServices(); err != nil {
		return nil, err
	}
	if err := b.buildChains(); err != nil {
		return nil, err
	}
	return &b.config, nil
}

type cfgBuilder struct {
	data   *model.NodeConfigData
	config config.Config
}

// ---- naming ----

func serviceName(ruleID int) string { return fmt.Sprintf("service-%d", ruleID) }
func targetName(ruleID int) string  { return fmt.Sprintf("target-%d", ruleID) }
func chainName(tunnelID int) string { return fmt.Sprintf("chain-%d", tunnelID) }
func nodeName(nodeID, tunnelID int) string {
	return fmt.Sprintf("node-%d-t%d", nodeID, tunnelID)
}
func hopName(tunnelID, index int) string {
	return fmt.Sprintf("hop-%d-%d", tunnelID, index)
}

// ---- lookups ----

func (b *cfgBuilder) chainsForTunnel(tunnelID int) []model.Chain {
	var out []model.Chain
	for _, c := range b.data.Chains {
		if c.TunnelID == tunnelID {
			out = append(out, c)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Index < out[j].Index })
	return out
}

func (b *cfgBuilder) inChainForNode(t *model.Tunnel) *model.Chain {
	for i, c := range b.data.Chains {
		if c.TunnelID == t.ID && c.NodeID == b.data.Node.ID && c.ChainType == model.ChainIn {
			return &b.data.Chains[i]
		}
	}
	return nil
}

func (b *cfgBuilder) outChain(t *model.Tunnel) *model.Chain {
	for i, c := range b.data.Chains {
		if c.TunnelID == t.ID && c.ChainType == model.ChainOut {
			return &b.data.Chains[i]
		}
	}
	return nil
}

func (b *cfgBuilder) chainForNodeInTunnel(t *model.Tunnel) *model.Chain {
	for i, c := range b.data.Chains {
		if c.TunnelID == t.ID && c.NodeID == b.data.Node.ID {
			return &b.data.Chains[i]
		}
	}
	return nil
}

// nodeRecord resolves the RelayNode a chain row belongs to: prefer the nodes
// list delivered by the control plane; fall back to the recipient node for
// legacy payloads that only carried it.
func (b *cfgBuilder) nodeRecord(nodeID int) *model.RelayNode {
	for i := range b.data.Nodes {
		if b.data.Nodes[i].ID == nodeID {
			return &b.data.Nodes[i]
		}
	}
	return &b.data.Node
}

// chainAddr resolves the address a chain row's node is dialed at: the node's
// own address plus the chain port, auto-allocated from that node's port range
// when 0 (the same deterministic formula the node itself uses for its relay
// listener, so both sides agree without coordination).
func (b *cfgBuilder) chainAddr(chain *model.Chain) (string, error) {
	rec := b.nodeRecord(chain.NodeID)
	port := chain.Port
	if port == 0 {
		var err error
		if port, err = allocatePortForChain(rec.Ports, chain.ID, chain.NodeID); err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("%s:%d", rec.Address, port), nil
}

// ---- services ----

func (b *cfgBuilder) buildServices() error {
	relayBuilt := map[int]bool{}
	quotaBuilt := map[string]bool{}

	for i := range b.data.Rules {
		rule := &b.data.Rules[i]

		var svc *config.ServiceConfig
		var err error
		// Entry-side services (the rule's listen port, limiters, quota) are
		// built by the node holding the tunnel's IN chain; exit-side shapes
		// differ per forward mode.
		isEntry := true

		if rule.TunnelID == nil {
			svc, err = b.forwardService(rule)
		} else {
			tunnel := b.findTunnel(*rule.TunnelID)
			if tunnel == nil {
				return fmt.Errorf("tunnel %d not found for rule %d", *rule.TunnelID, rule.ID)
			}
			if b.inChainForNode(tunnel) != nil {
				svc, err = b.entryService(rule, tunnel)
			} else {
				isEntry = false
				if tunnel.ForwardMode == model.ForwardModeRaw {
					// No port multiplexing: every rule gets its own dedicated
					// tcp/tcp exit service.
					svc, err = b.rawExitService(rule, tunnel)
				} else if relayBuilt[tunnel.ID] {
					// One relay listener serves every rule of the tunnel: the
					// relay protocol carries each connection's destination
					// in-band, so entry rules share a single exit port.
					continue
				} else {
					relayBuilt[tunnel.ID] = true
					svc, err = b.relayService(tunnel)
				}
			}
		}
		if err != nil {
			return err
		}
		// enableStats (service metadata) is required for observers to
		// report traffic stats for the service.
		svc.Metadata = map[string]any{"enableStats": "true"}
		svc.Observer = ObserverName
		// Traffic allowance: only the rule's ENTRY service enforces it (entry
		// nodes and standalone forwards). Exit services never carry quotas —
		// the shared relay listener belongs to many rules, and a raw-mode exit
		// leg mirrors the entry leg (counting both would double-dip one
		// allowance). Several rules may share one quota name (per-user
		// allowance): emit the object once, every service references it.
		if isEntry {
			if quota := b.quotaFor(rule); quota != nil {
				svc.Quotas = []string{quota.Name}
				if !quotaBuilt[quota.Name] {
					quotaBuilt[quota.Name] = true
					b.config.Quotas = append(b.config.Quotas, quota)
				}
			}
		}
		b.config.Services = append(b.config.Services, svc)
	}
	return nil
}

// forwardService is the tunnel-less shape: plain TCP port forwarding.
func (b *cfgBuilder) forwardService(rule *model.RelayRule) (*config.ServiceConfig, error) {
	svc := b.baseService(rule)
	svc.Handler = &config.HandlerConfig{Type: "tcp"}
	svc.Listener = &config.ListenerConfig{Type: "tcp"}
	svc.Forwarder = b.forwarder(rule, true)
	b.attachLimiters(svc, rule)
	return svc, nil
}

// entryService listens on the rule's port. One service per rule; all rules of
// a tunnel reference the same chain (chains are deduplicated per tunnel).
// Raw-mode tunnels with an exit forward straight to the rule's dedicated exit
// port (no chain object, no relay protocol); a single-node raw tunnel has no
// exit and falls through to the direct-forward shape below (identical bytes
// to the legacy 1-hop form).
func (b *cfgBuilder) entryService(rule *model.RelayRule, tunnel *model.Tunnel) (*config.ServiceConfig, error) {
	svc := b.baseService(rule)
	if tunnel.ForwardMode == model.ForwardModeRaw && b.outChain(tunnel) != nil {
		addr, err := b.rawExitAddr(rule, tunnel)
		if err != nil {
			return nil, err
		}
		svc.Handler = &config.HandlerConfig{Type: "tcp"}
		svc.Listener = &config.ListenerConfig{Type: "tcp"}
		svc.Forwarder = &config.ForwarderConfig{
			Nodes:    []*config.ForwardNodeConfig{{Name: targetName(rule.ID), Addr: addr}},
			Selector: defaultSelector("round"),
		}
		b.attachLimiters(svc, rule)
		return svc, nil
	}
	chains := b.chainsForTunnel(tunnel.ID)
	switch len(chains) {
	case 1: // single-hop forwarding
		svc.Handler = &config.HandlerConfig{Type: "tcp"}
		svc.Listener = &config.ListenerConfig{Type: "tcp"}
		svc.Forwarder = b.forwarder(rule, true)
	case 2: // two-hop relay
		svc.Handler = &config.HandlerConfig{Type: "tcp", Chain: chainName(tunnel.ID)}
		svc.Listener = &config.ListenerConfig{Type: "tcp"}
		svc.Forwarder = b.forwarder(rule, false)
	default: // multi-hop relay (3+ nodes)
		svc.Handler = &config.HandlerConfig{Type: "auto", Chain: chainName(tunnel.ID)}
		svc.Listener = &config.ListenerConfig{Type: "tcp"}
	}
	b.attachLimiters(svc, rule)
	return svc, nil
}

// relayService is the exit/relay-node shape: ONE relay listener per tunnel
// (name service-t{tunnelId}), independent of the entry-side rule count. Its
// port may even numerically equal an entry listen port — they live on
// different machines. Port 0 auto-allocates from this node's own chain row
// (the same deterministic formula entries use to dial it).
// Rule limiters apply at the entry services, not here.
// Relay-protocol auth rides the handler whenever the tunnel carries
// credentials; TLS tunnels additionally wrap the listener (mutual
// verification against the platform CA) and guard it with an admission
// whitelist of the tunnel's entry IPs.
func (b *cfgBuilder) relayService(tunnel *model.Tunnel) (*config.ServiceConfig, error) {
	nodeChain := b.chainForNodeInTunnel(tunnel)
	if nodeChain == nil {
		return nil, fmt.Errorf("node %d has no chain in tunnel %d", b.data.Node.ID, tunnel.ID)
	}
	rec := b.nodeRecord(nodeChain.NodeID) // == the recipient itself on exits
	port := nodeChain.Port
	if port == 0 {
		var err error
		if port, err = allocatePortForChain(rec.Ports, nodeChain.ID, nodeChain.NodeID); err != nil {
			return nil, err
		}
	}
	transport := model.TransportRaw
	if out := b.outChain(tunnel); out != nil {
		transport = out.Transport
	}
	svc := &config.ServiceConfig{
		Name:     fmt.Sprintf("service-t%d", tunnel.ID),
		Addr:     fmt.Sprintf(":%d", port),
		Handler:  &config.HandlerConfig{Type: "relay", Auth: relayAuth(tunnel)},
		Listener: &config.ListenerConfig{Type: dialerType(transport)},
	}
	if b.linkTLSEnabled(tunnel) {
		svc.Listener.TLS = b.listenerTLS(transport)
		if transport == model.TransportGRPC {
			svc.Listener.Metadata = map[string]any{"path": "/grpc"}
		}
		if admission := b.admissionFor(tunnel); admission != nil {
			svc.Admission = admission.Name
			b.config.Admissions = append(b.config.Admissions, admission)
		}
	}
	return svc, nil
}

func (b *cfgBuilder) baseService(rule *model.RelayRule) *config.ServiceConfig {
	return &config.ServiceConfig{
		Name: serviceName(rule.ID),
		Addr: fmt.Sprintf(":%d", rule.ListenPort),
	}
}

func (b *cfgBuilder) forwarder(rule *model.RelayRule, withSelector bool) *config.ForwarderConfig {
	fwd := &config.ForwarderConfig{
		Nodes: []*config.ForwardNodeConfig{
			{Name: targetName(rule.ID), Addr: rule.Targets},
		},
	}
	if withSelector {
		fwd.Selector = defaultSelector("round")
	}
	return fwd
}

func (b *cfgBuilder) findTunnel(id int) *model.Tunnel {
	for i := range b.data.Tunnels {
		if b.data.Tunnels[i].ID == id {
			return &b.data.Tunnels[i]
		}
	}
	return nil
}

func (b *cfgBuilder) attachLimiters(svc *config.ServiceConfig, rule *model.RelayRule) {
	set := parseLimiters(rule.Limit, rule.ID)
	if len(set.limiters) > 0 {
		svc.Limiter = set.limiters[0].Name
	}
	if len(set.rlimiters) > 0 {
		svc.RLimiter = set.rlimiters[0].Name
	}
	if len(set.climiters) > 0 {
		svc.CLimiter = set.climiters[0].Name
	}
	// Emit the limiter objects alongside the service that references them —
	// exit relay services carry no limiters, so their rules contribute none.
	b.config.Limiters = append(b.config.Limiters, set.limiters...)
	b.config.RLimiters = append(b.config.RLimiters, set.rlimiters...)
	b.config.CLimiters = append(b.config.CLimiters, set.climiters...)
}

// ---- chains (entry nodes only) ----

func (b *cfgBuilder) buildChains() error {
	processed := map[int]bool{}

	for i := range b.data.Rules {
		rule := &b.data.Rules[i]
		if rule.TunnelID == nil || processed[*rule.TunnelID] {
			continue
		}
		tunnel := b.findTunnel(*rule.TunnelID)
		inChain := b.inChainForNode(tunnel)
		if tunnel == nil || inChain == nil {
			continue // not an entry node
		}
		processed[tunnel.ID] = true

		// Raw-mode entries dial the exit's per-rule ports directly from their
		// forwarders — no chain object exists (and no relay protocol bytes
		// hit the wire).
		if tunnel.ForwardMode == model.ForwardModeRaw {
			continue
		}

		chains := b.chainsForTunnel(tunnel.ID)
		switch {
		case len(chains) == 2:
			if out := b.outChain(tunnel); out != nil {
				chain, err := b.twoHopChain(tunnel, out)
				if err != nil {
					return err
				}
				b.config.Chains = append(b.config.Chains, chain)
			}
		case len(chains) > 2:
			chain, err := b.multiHopChain(tunnel, chains)
			if err != nil {
				return err
			}
			b.config.Chains = append(b.config.Chains, chain)
		}
	}
	return nil
}

// twoHopChain builds a chain whose single hop is the EXIT node (its chain
// row): the relay connector hands each connection's destination to the exit's
// relay listener, dialed over the exit row's transport. The connector carries
// the tunnel's relay credentials when present; TLS tunnels dial with the
// platform client cert and verify the exit against the platform CA.
func (b *cfgBuilder) twoHopChain(tunnel *model.Tunnel, out *model.Chain) (*config.ChainConfig, error) {
	node, err := b.nodeConfig(out, tunnel, out.Transport, "relay")
	if err != nil {
		return nil, err
	}
	node.Connector.Auth = relayAuth(tunnel)
	if b.linkTLSEnabled(tunnel) {
		node.Dialer.TLS = b.dialerTLS(out.Transport)
		if out.Transport == model.TransportGRPC {
			// :authority / SNI disguise — the dial targets an IP, the TLS
			// handshake presents the platform domain.
			node.Dialer.Metadata = map[string]any{"host": b.data.TLSMaterial.SNI, "path": "/grpc"}
		}
	}
	return &config.ChainConfig{
		Name: chainName(tunnel.ID),
		Hops: []*config.HopConfig{
			{Name: hopName(tunnel.ID, out.Index), Nodes: []*config.NodeConfig{node}},
		},
	}, nil
}

// multiHopChain includes every node as its own hop. No chain-level selector:
// the GOST chain schema only has name/hops/metadata and would silently drop it.
func (b *cfgBuilder) multiHopChain(tunnel *model.Tunnel, chains []model.Chain) (*config.ChainConfig, error) {
	hops := make([]*config.HopConfig, 0, len(chains))
	for i := range chains {
		chain := &chains[i]
		node, err := b.nodeConfig(chain, tunnel, chain.Transport, "")
		if err != nil {
			return nil, err
		}
		hop := &config.HopConfig{
			Name:  hopName(tunnel.ID, chain.Index),
			Nodes: []*config.NodeConfig{node},
		}
		if chain.Strategy != "" && chain.Strategy != "round" {
			hop.Selector = defaultSelector(chain.Strategy)
		}
		hops = append(hops, hop)
	}
	return &config.ChainConfig{Name: chainName(tunnel.ID), Hops: hops}, nil
}

func (b *cfgBuilder) nodeConfig(chain *model.Chain, tunnel *model.Tunnel, dialerTransport model.Transport, connectorOverride string) (*config.NodeConfig, error) {
	connector := connectorOverride
	if connector == "" {
		connector = connectorType(chain.ChainType)
	}
	addr, err := b.chainAddr(chain)
	if err != nil {
		return nil, err
	}
	return &config.NodeConfig{
		Name:      nodeName(chain.NodeID, tunnel.ID),
		Addr:      addr,
		Connector: &config.ConnectorConfig{Type: connector},
		Dialer:    &config.DialerConfig{Type: dialerType(dialerTransport)},
	}, nil
}
