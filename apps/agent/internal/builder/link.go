// Raw-mode forwarding, link TLS and admission — the censorship-evasion layer
// of the builder. See builder.go for the base shapes.
package builder

import (
	"fmt"
	"net"

	"github.com/go-gost/x/config"
	"github.com/laoshan-tech/tyz/apps/agent/internal/certs"
	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
)

func admissionName(tunnelID int) string { return fmt.Sprintf("admission-t%d", tunnelID) }

func certPath(name string) string { return certs.DirName + "/" + name }

// linkTLSOptions pins the link profile: TLS 1.3 only, and ALPN h2 for grpc
// transport so the flow is indistinguishable from ordinary gRPC/HTTP2 traffic
// (matching the reference deployment).
func linkTLSOptions(transport model.Transport) *config.TLSOptions {
	opts := &config.TLSOptions{
		MinVersion: "VersionTLS13",
		MaxVersion: "VersionTLS13",
	}
	if transport == model.TransportGRPC {
		opts.ALPN = []string{"h2"}
	}
	return opts
}

// listenerTLS is the exit-side relay listener TLS: the platform server cert
// plus the CA (GOST turns caFile into RequireAndVerifyClientCert — mutual
// TLS), SNI locked to the platform domain, unknown SNI rejected.
func (b *cfgBuilder) listenerTLS(transport model.Transport) *config.TLSConfig {
	m := b.data.TLSMaterial
	return &config.TLSConfig{
		CertFile:         certPath(certs.ServerCert),
		KeyFile:          certPath(certs.ServerKey),
		CAFile:           certPath(certs.CACertFile),
		RejectUnknownSNI: true,
		ServerNames:      []string{m.SNI},
		Options:          linkTLSOptions(transport),
	}
}

// dialerTLS is the entry-side chain dialer TLS: verify the exit against the
// platform CA (secure + serverName) and present the client cert.
func (b *cfgBuilder) dialerTLS(transport model.Transport) *config.TLSConfig {
	m := b.data.TLSMaterial
	return &config.TLSConfig{
		Secure:     true,
		ServerName: m.SNI,
		CAFile:     certPath(certs.CACertFile),
		CertFile:   certPath(certs.ClientCert),
		KeyFile:    certPath(certs.ClientKey),
		Options:    linkTLSOptions(transport),
	}
}

// relayAuth is the in-band relay-protocol credential pair for a tunnel. Empty
// on legacy payloads (pre-migration cached configs) — nothing is emitted then,
// which keeps the builder byte-compatible with existing goldens.
func relayAuth(tunnel *model.Tunnel) *config.AuthConfig {
	if tunnel.RelayAuthUser == "" && tunnel.RelayAuthPass == "" {
		return nil
	}
	return &config.AuthConfig{Username: tunnel.RelayAuthUser, Password: tunnel.RelayAuthPass}
}

// linkTLSEnabled reports whether this tunnel's relay link runs TLS. Trust the
// payload (the control plane validates and normalizes the flag), but only
// apply it on the 2-hop shape — a 3+ hop tunnel must not have one end of a
// multi-link path silently encrypting.
func (b *cfgBuilder) linkTLSEnabled(tunnel *model.Tunnel) bool {
	return tunnel.TLSEnabled && b.data.TLSMaterial != nil && len(b.chainsForTunnel(tunnel.ID)) == 2
}

// admissionFor builds the IP whitelist guarding a TLS relay listener: every
// entry node of the tunnel contributes its address as a /32 (or /128)
// matcher. Non-IP addresses are skipped (the admission matcher grammar is
// CIDR-only); an empty matcher list means no admission object.
func (b *cfgBuilder) admissionFor(tunnel *model.Tunnel) *config.AdmissionConfig {
	var matchers []string
	for _, chain := range b.chainsForTunnel(tunnel.ID) {
		if chain.ChainType != model.ChainIn {
			continue
		}
		if matcher := admissionMatcher(b.nodeRecord(chain.NodeID).Address); matcher != "" {
			matchers = append(matchers, matcher)
		}
	}
	if len(matchers) == 0 {
		return nil
	}
	return &config.AdmissionConfig{
		Name:      admissionName(tunnel.ID),
		Whitelist: true,
		Matchers:  matchers,
	}
}

func admissionMatcher(address string) string {
	host := address
	if h, _, err := net.SplitHostPort(address); err == nil {
		host = h
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return ""
	}
	if ip.To4() != nil {
		return host + "/32"
	}
	return host + "/128"
}

// rawExitPort resolves the rule's dedicated exit-side port: explicit
// relay_rules.exit_port, else deterministic allocation from the exit node's
// port range. The entry computes the SAME value via the same inputs, so both
// ends agree without coordination (collisions surface as apply_failed
// health; the operator pins an explicit port to fix one).
func (b *cfgBuilder) rawExitPort(rule *model.RelayRule, tunnel *model.Tunnel) (int, error) {
	out := b.outChain(tunnel)
	if out == nil {
		return 0, fmt.Errorf("tunnel %d has no out chain for raw rule %d", tunnel.ID, rule.ID)
	}
	if rule.ExitPort > 0 {
		return rule.ExitPort, nil
	}
	rec := b.nodeRecord(out.NodeID)
	return allocatePortForRule(rec.Ports, rule.ID, out.NodeID)
}

// rawExitAddr is the address the ENTRY dials for a raw-mode rule.
func (b *cfgBuilder) rawExitAddr(rule *model.RelayRule, tunnel *model.Tunnel) (string, error) {
	out := b.outChain(tunnel)
	if out == nil {
		return "", fmt.Errorf("tunnel %d has no out chain for raw rule %d", tunnel.ID, rule.ID)
	}
	port, err := b.rawExitPort(rule, tunnel)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s:%d", b.nodeRecord(out.NodeID).Address, port), nil
}

// rawExitService is the exit-node shape of a raw-mode rule: a dedicated
// tcp/tcp listener on the rule's exit port forwarding to the real target.
// Same name as the entry's service (service-{ruleId}) — the two live on
// different machines with independent registries, and the panel's restart
// directive naturally rebuilds both ends. No limiters/quotas here: they are
// enforced at the entry (counting both legs would double-dip one allowance).
func (b *cfgBuilder) rawExitService(rule *model.RelayRule, tunnel *model.Tunnel) (*config.ServiceConfig, error) {
	port, err := b.rawExitPort(rule, tunnel)
	if err != nil {
		return nil, err
	}
	svc := &config.ServiceConfig{
		Name:     serviceName(rule.ID),
		Addr:     fmt.Sprintf(":%d", port),
		Handler:  &config.HandlerConfig{Type: "tcp"},
		Listener: &config.ListenerConfig{Type: "tcp"},
	}
	svc.Forwarder = b.forwarder(rule, true)
	return svc, nil
}
