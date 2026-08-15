/**
 * GOST configuration builder
 * Converts database entities to GOST configuration format
 */

import { type Chain, ChainType, type NodeConfigData, type RelayRule, Transport, type Tunnel } from "@tyz/shared";
import type { GostConfig } from "../../types/gost";
import { LimiterParser } from "./limiter";
import { PortAllocator, TransportMapper } from "./mapper";
import { TLSGenerator } from "./tls";

// Name of the stats observer defined in the node's base GOST config
// (config/gost.json). GOST v3 only reports stats for services that
// explicitly reference an observer.
const GOST_OBSERVER_NAME = "stats-observer";

// Constants
const DEFAULT_SELECTOR = {
  strategy: "round",
  maxFails: 1,
  failTimeout: 30,
};

/**
 * Centralized naming factory for GOST configuration entities
 */
class ServiceNaming {
  static service(ruleId: number): string {
    return `service-${ruleId}`;
  }

  static target(ruleId: number): string {
    return `target-${ruleId}`;
  }

  static chain(tunnelId: number): string {
    return `chain-${tunnelId}`;
  }

  static node(nodeId: number, tunnelId: number): string {
    return `node-${nodeId}-t${tunnelId}`;
  }

  static hop(tunnelId: number, index: number): string {
    return `hop-${tunnelId}-${index}`;
  }
}

/**
 * Build GOST configuration from node configuration data
 */
export class GOSTConfigBuilder {
  // Config keys for limiter types
  private static readonly LIMITER_TYPES = ["limiters", "rlimiters", "climiters"] as const;
  private static readonly SERVICE_LIMITER_KEYS = ["limiter", "rlimiter", "climiter"] as const;

  private data: NodeConfigData;
  private config: GostConfig;

  constructor(data: NodeConfigData) {
    this.data = data;
    this.config = {
      services: [],
      chains: [],
      limiters: [],
      rlimiters: [],
      climiters: [],
    };
  }

  /**
   * Build complete GOST configuration
   */
  build(): GostConfig {
    this.buildServices();
    this.buildChains();
    this.buildLimiters();
    return this.config;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Get chains for a specific tunnel
   */
  private getChainsForTunnel(tunnelId: number): Chain[] {
    return this.data.chains.filter((c) => c.tunnel_id === tunnelId).sort((a, b) => a.index - b.index);
  }

  /**
   * Get IN chain for current node in a tunnel
   */
  private getInChainForNode(tunnel: Tunnel): Chain | undefined {
    return this.data.chains.find(
      (c) => c.tunnel_id === tunnel.id && c.node_id === this.data.node.id && c.chain_type === ChainType.IN,
    );
  }

  /**
   * Get OUT chain for a tunnel
   */
  private getOutChain(tunnel: Tunnel): Chain | undefined {
    return this.data.chains.find((c) => c.tunnel_id === tunnel.id && c.chain_type === ChainType.OUT);
  }

  /**
   * Get chain for current node in tunnel (any type)
   */
  private getChainForNodeInTunnel(tunnel: Tunnel): Chain | undefined {
    return this.data.chains.find((c) => c.tunnel_id === tunnel.id && c.node_id === this.data.node.id);
  }

  /**
   * Get address for a chain node
   */
  private getChainAddr(chain: Chain, tunnel: Tunnel): string {
    // If it's an IN chain and tunnel has ingress_display_address, use that
    if (chain.chain_type === ChainType.IN && tunnel.ingress_display_address) {
      return tunnel.ingress_display_address;
    }

    // Otherwise use node address with port
    const node = this.data.node; // Chain's node (assuming it's the same as current node)
    const port = chain.port || PortAllocator.allocatePortForChain(node.ports, chain.id, node.id);
    return `${node.address}:${port}`;
  }

  /**
   * Add limiters to service configuration
   */
  private addLimitersToService(service: any, rule: RelayRule): void {
    const limiterConfig = LimiterParser.parseLimiterConfig(rule.limit, rule.id);

    GOSTConfigBuilder.LIMITER_TYPES.forEach((limiterType, index) => {
      const serviceKey = GOSTConfigBuilder.SERVICE_LIMITER_KEYS[index];
      const limiters = limiterConfig[limiterType];

      if (limiters && limiters.length > 0) {
        service[serviceKey] = limiters[0].name;
      }
    });
  }

  /**
   * Create base service configuration
   */
  private createBaseService(rule: RelayRule): any {
    return {
      name: ServiceNaming.service(rule.id),
      addr: `:${rule.listen_port}`,
    };
  }

  /**
   * Create forwarder configuration
   */
  private createForwarder(rule: RelayRule, withSelector: boolean = true): any {
    const forwarder: any = {
      nodes: [
        {
          name: ServiceNaming.target(rule.id),
          addr: rule.targets,
        },
      ],
    };

    if (withSelector) {
      forwarder.selector = { ...DEFAULT_SELECTOR };
    }

    return forwarder;
  }

  /**
   * Build node configuration for a chain
   */
  private buildNodeConfig(chain: Chain, tunnel: Tunnel, dialerTransport: Transport, connectorType?: string): any {
    const connector = connectorType || TransportMapper.getConnectorType(chain.chain_type);

    const node: any = {
      name: ServiceNaming.node(chain.node_id, tunnel.id),
      addr: this.getChainAddr(chain, tunnel),
      connector: { type: connector },
      dialer: { type: TransportMapper.getDialerType(dialerTransport) },
    };

    // TLS transports get the auto-generated certificate parameters.
    // Per GOST v3 config schema this belongs on NodeConfig.tls — a global
    // `tls` section does not exist and would be silently ignored.
    if (TLSGenerator.needsTLSConfig(dialerTransport)) {
      node.tls = TLSGenerator.generateCertInfo(this.data.tls?.commonName, this.data.tls?.organization);
    }

    return node;
  }

  // ============================================================================
  // Service Building Methods
  // ============================================================================

  /**
   * Build GOST Services from RelayRules
   */
  private buildServices(): void {
    for (const rule of this.data.rules) {
      const service = this.buildService(rule);
      // enableStats (as metadata, per GOST v3 service spec) is required for
      // observers to report traffic stats for the service.
      service.metadata = { ...service.metadata, enableStats: "true" };
      service.observer = GOST_OBSERVER_NAME;
      this.config.services?.push(service);
    }
  }

  /**
   * Build a single GOST Service from a RelayRule
   */
  private buildService(rule: RelayRule): any {
    if (!rule.tunnel_id) {
      // No tunnel, simple forwarding service
      const service = this.createBaseService(rule);
      service.handler = { type: "tcp" };
      service.listener = { type: "tcp" };
      service.forwarder = this.createForwarder(rule, true);
      this.addLimitersToService(service, rule);
      return service;
    }

    const tunnel = this.data.tunnels.find((t) => t.id === rule.tunnel_id);
    if (!tunnel) {
      throw new Error(`Tunnel ${rule.tunnel_id} not found for rule ${rule.id}`);
    }

    const inChain = this.getInChainForNode(tunnel);
    let service: any;

    if (!inChain) {
      // Not an IN node, so it's CHAIN or OUT node - use its chain's port
      const nodeChain = this.getChainForNodeInTunnel(tunnel);

      if (nodeChain?.port) {
        service = {
          name: ServiceNaming.service(rule.id),
          addr: `:${nodeChain.port}`,
        };
      } else {
        service = this.createBaseService(rule);
      }

      // Exit node service (relay handler)
      service.handler = { type: "relay" };
      const outChain = this.getOutChain(tunnel);
      const transport = outChain ? outChain.transport : Transport.RAW;
      service.listener = { type: TransportMapper.getDialerType(transport) };
    } else {
      // IN node - use rule's listen_port
      service = this.createBaseService(rule);

      const chains = this.getChainsForTunnel(tunnel.id);
      const chainCount = chains.length;

      if (chainCount === 1) {
        // Single-hop forwarding
        Object.assign(service, this.buildSingleHopService(rule));
      } else if (chainCount === 2) {
        // Two-hop relay
        Object.assign(service, this.buildTwoHopService(rule, tunnel));
      } else {
        // Multi-hop relay (3+ nodes)
        Object.assign(service, this.buildMultiHopService(tunnel));
      }
    }

    this.addLimitersToService(service, rule);
    return service;
  }

  /**
   * Build service config for single-hop forwarding
   */
  private buildSingleHopService(rule: RelayRule): any {
    return {
      handler: { type: "tcp" },
      listener: { type: "tcp" },
      forwarder: this.createForwarder(rule, true),
    };
  }

  /**
   * Build service config for two-hop relay
   */
  private buildTwoHopService(rule: RelayRule, tunnel: Tunnel): any {
    return {
      handler: {
        type: "tcp",
        chain: ServiceNaming.chain(tunnel.id),
      },
      listener: { type: "tcp" },
      forwarder: this.createForwarder(rule, false),
    };
  }

  /**
   * Build service config for multi-hop relay (3+ nodes)
   */
  private buildMultiHopService(tunnel: Tunnel): any {
    return {
      handler: {
        type: "auto",
        chain: ServiceNaming.chain(tunnel.id),
      },
      listener: { type: "tcp" },
    };
  }

  // ============================================================================
  // Chain Building Methods
  // ============================================================================

  /**
   * Build GOST Chains (only for entry nodes)
   */
  private buildChains(): void {
    const processedTunnels = new Set<number>();

    for (const rule of this.data.rules) {
      if (!rule.tunnel_id || processedTunnels.has(rule.tunnel_id)) {
        continue;
      }

      const tunnel = this.data.tunnels.find((t) => t.id === rule.tunnel_id);
      if (!tunnel) {
        continue;
      }

      const inChain = this.getInChainForNode(tunnel);
      if (!inChain) {
        continue; // Not an entry node
      }

      processedTunnels.add(tunnel.id);

      const chains = this.getChainsForTunnel(tunnel.id);
      const chainCount = chains.length;

      if (chainCount === 2) {
        const outChain = this.getOutChain(tunnel);
        if (outChain) {
          this.config.chains?.push(this.buildTwoHopChain(tunnel, inChain, outChain));
        }
      } else if (chainCount > 2) {
        this.config.chains?.push(this.buildMultiHopChain(tunnel, chains));
      }
    }
  }

  /**
   * Build a chain for two-hop relay (only includes IN node)
   */
  private buildTwoHopChain(tunnel: Tunnel, inChain: Chain, outChain: Chain): any {
    return {
      name: ServiceNaming.chain(tunnel.id),
      hops: [
        {
          name: ServiceNaming.hop(tunnel.id, inChain.index),
          nodes: [this.buildNodeConfig(inChain, tunnel, outChain.transport, "relay")],
        },
      ],
    };
  }

  /**
   * Build a chain for multi-hop relay (includes all nodes)
   */
  private buildMultiHopChain(tunnel: Tunnel, chains: Chain[]): any {
    // Note: no chain-level selector — the GOST v3 chain schema only has
    // name/hops/metadata; a chain-level selector would be silently dropped
    // (and cause perpetual diff mismatches in the object sync).
    return {
      name: ServiceNaming.chain(tunnel.id),
      hops: chains.map((chain) => this.buildHop(tunnel, chain)),
    };
  }

  /**
   * Build a single hop in a multi-hop chain
   */
  private buildHop(tunnel: Tunnel, chain: Chain): any {
    const hop: any = {
      name: ServiceNaming.hop(tunnel.id, chain.index),
      nodes: [this.buildNodeConfig(chain, tunnel, chain.transport)],
    };

    if (chain.strategy && chain.strategy !== "round") {
      hop.selector = { ...DEFAULT_SELECTOR, strategy: chain.strategy };
    }

    return hop;
  }

  // ============================================================================
  // TLS and Limiters
  // ============================================================================

  /**
   * Build limiter configurations from rules
   */
  private buildLimiters(): void {
    for (const rule of this.data.rules) {
      const limiterConfig = LimiterParser.parseLimiterConfig(rule.limit, rule.id);

      GOSTConfigBuilder.LIMITER_TYPES.forEach((limiterType) => {
        const limiters = limiterConfig[limiterType];
        if (limiters && limiters.length > 0) {
          this.config[limiterType]?.push(...limiters);
        }
      });
    }
  }
}

/**
 * Generate GOST configuration from node configuration data
 * This is the main entry point for building GOST configurations
 */
export function generateGostConfig(data: NodeConfigData): GostConfig {
  return new GOSTConfigBuilder(data).build();
}
