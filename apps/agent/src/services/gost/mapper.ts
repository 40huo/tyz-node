/**
 * Transport mapping utilities for GOST configuration
 * Maps internal transport types to GOST dialer/connector types
 */

import { ChainType, Transport } from "@tyz/shared";

export class TransportMapper {
  // Dialer type mapping (transport -> GOST dialer type)
  private static readonly DIALER_TYPE_MAP: Record<Transport, string> = {
    [Transport.RAW]: "tcp",
    [Transport.WS]: "ws",
    [Transport.TLS]: "tls",
    [Transport.GRPC]: "grpc",
    [Transport.WSS]: "ws",
    [Transport.MTLS]: "mtls",
    [Transport.MWSS]: "mws",
  };

  // Connector type mapping (chain type -> GOST connector type)
  private static readonly CONNECTOR_TYPE_MAP: Record<ChainType, string> = {
    [ChainType.IN]: "forward",
    [ChainType.CHAIN]: "relay",
    [ChainType.OUT]: "forward",
  };

  /**
   * Get GOST dialer type from transport type
   */
  static getDialerType(transport: Transport): string {
    return TransportMapper.DIALER_TYPE_MAP[transport] || "tcp";
  }

  /**
   * Get GOST connector type from chain type
   */
  static getConnectorType(chainType: ChainType): string {
    return TransportMapper.CONNECTOR_TYPE_MAP[chainType] || "forward";
  }
}

export class PortAllocator {
  /**
   * Parse port range string like "1000-65535"
   */
  static parsePortRange(portsStr: string): [number, number] {
    if (!portsStr || !portsStr.includes("-")) {
      throw new Error(`Invalid port range format: ${portsStr}`);
    }

    const parts = portsStr.split("-");
    if (parts.length !== 2) {
      throw new Error(`Invalid port range format: ${portsStr}`);
    }

    const start = parseInt(parts[0], 10);
    const end = parseInt(parts[1], 10);

    if (Number.isNaN(start) || Number.isNaN(end)) {
      throw new Error(`Port range must be integers: ${portsStr}`);
    }

    if (start < 1 || start > 65535 || end < 1 || end > 65535) {
      throw new Error(`Port range must be 1-65535: ${portsStr}`);
    }

    if (start > end) {
      throw new Error(`Start port must be <= end port: ${portsStr}`);
    }

    return [start, end];
  }

  /**
   * Allocate a port for a Chain from the node's available port range
   * Uses a simple hash-based allocation
   */
  static allocatePortForChain(nodePortsRange: string, chainId: number, nodeId: number): number {
    const [start, end] = PortAllocator.parsePortRange(nodePortsRange);
    const portRange = end - start + 1;

    // Simple hash-based allocation (same algorithm as Python version)
    const allocatedPort = start + ((chainId + nodeId) % portRange);

    return allocatedPort;
  }
}
