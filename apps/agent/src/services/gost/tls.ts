/**
 * TLS certificate configuration generation for GOST
 */

import { Transport } from "@tyz/shared";

interface TLSConfig {
  validity: string;
  commonName: string;
  organization: string;
}

export class TLSGenerator {
  // Transports that require TLS configuration
  private static readonly TLS_TRANSPORTS = new Set<Transport>([
    Transport.TLS,
    Transport.MTLS,
    Transport.WSS,
    Transport.MWSS,
  ]);

  // Transports that require mutual TLS
  private static readonly MTLS_TRANSPORTS = new Set<Transport>([Transport.MTLS, Transport.MWSS]);

  // Default values
  private static readonly DEFAULT_COMMON_NAME = "relay.gost.com";
  private static readonly DEFAULT_ORGANIZATION = "GOSTCOM";

  /**
   * Generate TLS certificate information
   */
  static generateCertInfo(commonName?: string, organization?: string): TLSConfig {
    return {
      validity: "8760h", // 1 year
      commonName: commonName || TLSGenerator.DEFAULT_COMMON_NAME,
      organization: organization || TLSGenerator.DEFAULT_ORGANIZATION,
    };
  }

  /**
   * Check if transport type needs TLS configuration
   */
  static needsTLSConfig(transport: Transport): boolean {
    return TLSGenerator.TLS_TRANSPORTS.has(transport);
  }

  /**
   * Check if transport type needs mutual TLS configuration
   */
  static needsMTLSConfig(transport: Transport): boolean {
    return TLSGenerator.MTLS_TRANSPORTS.has(transport);
  }
}
