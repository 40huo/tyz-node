/**
 * Limiter configuration parsing for GOST
 * Parses RelayRule limit configuration to GOST limiter format
 */

import type { LimiterConfig } from "@tyz/shared";

interface GostLimiter {
  name: string;
  limits: string[];
}

interface ParsedLimiters {
  limiters?: GostLimiter[];
  rlimiters?: GostLimiter[];
  climiters?: GostLimiter[];
}

export class LimiterParser {
  /**
   * Parse RelayRule limit field to GOST limiter configuration
   * Accepts both JSON object (from database) and string (legacy support)
   */
  static parseLimiterConfig(limitConfig: LimiterConfig | string | null | undefined, ruleId: number): ParsedLimiters {
    try {
      if (!limitConfig) {
        return {};
      }

      // Handle string input (legacy support)
      let limitData: LimiterConfig;
      if (typeof limitConfig === "string") {
        if (limitConfig === "{}") {
          return {};
        }
        limitData = JSON.parse(limitConfig);
      } else {
        limitData = limitConfig;
      }

      if (typeof limitData !== "object" || limitData === null) {
        return {};
      }

      const result: ParsedLimiters = {};

      // Traffic rate limiting
      if (limitData.traffic) {
        result.limiters = LimiterParser.buildTrafficLimiter(limitData.traffic, ruleId);
      }

      // Request rate limiting
      if (limitData.request) {
        result.rlimiters = LimiterParser.buildRequestLimiter(limitData.request, ruleId);
      }

      // Connection limiting
      if (limitData.connection) {
        result.climiters = LimiterParser.buildConnectionLimiter(limitData.connection, ruleId);
      }

      return result;
    } catch (_error) {
      // Invalid JSON or other errors, return empty config
      return {};
    }
  }

  /**
   * Build IP-specific limiters
   */
  private static buildIpLimiters(
    ipsConfig: Array<any>,
    ruleId: number,
    prefix: string,
    valueKeys: string[],
  ): GostLimiter[] {
    const limiters: GostLimiter[] = [];

    for (let idx = 0; idx < ipsConfig.length; idx++) {
      const ipConfig = ipsConfig[idx];
      if (typeof ipConfig !== "object" || !ipConfig) {
        continue;
      }

      const ip = ipConfig.ip;
      if (!ip) {
        continue;
      }

      const values = valueKeys.map((key) => String(ipConfig[key] || 0));
      limiters.push({
        name: `${prefix}-ip-${ruleId}-${idx}`,
        limits: [`${ip} ${values.join(" ")}`],
      });
    }

    return limiters;
  }

  /**
   * Build traffic rate limiters
   */
  private static buildTrafficLimiter(trafficConfig: any, ruleId: number): GostLimiter[] {
    const limiters: GostLimiter[] = [];

    // Service-level traffic limiting
    if (trafficConfig.service_in !== undefined || trafficConfig.service_out !== undefined) {
      const inRate = trafficConfig.service_in || 0;
      const outRate = trafficConfig.service_out || 0;
      limiters.push({
        name: `limiter-service-${ruleId}`,
        limits: [`$ ${inRate} ${outRate}`],
      });
    }

    // Connection-level traffic limiting
    if (trafficConfig.conn_in !== undefined || trafficConfig.conn_out !== undefined) {
      const inRate = trafficConfig.conn_in || 0;
      const outRate = trafficConfig.conn_out || 0;
      limiters.push({
        name: `limiter-conn-${ruleId}`,
        limits: [`$$ ${inRate} ${outRate}`],
      });
    }

    // IP-specific traffic limiting
    if (trafficConfig.ips && Array.isArray(trafficConfig.ips)) {
      limiters.push(...LimiterParser.buildIpLimiters(trafficConfig.ips, ruleId, "limiter", ["in", "out"]));
    }

    return limiters;
  }

  /**
   * Build request rate limiters
   */
  private static buildRequestLimiter(requestConfig: any, ruleId: number): GostLimiter[] {
    const limiters: GostLimiter[] = [];

    // Service-level request limiting
    if (requestConfig.service_rate !== undefined) {
      const rate = requestConfig.service_rate || 0;
      limiters.push({
        name: `rlimiter-service-${ruleId}`,
        limits: [`$ ${rate}`],
      });
    }

    // IP-level request limiting
    if (requestConfig.ips && Array.isArray(requestConfig.ips)) {
      limiters.push(...LimiterParser.buildIpLimiters(requestConfig.ips, ruleId, "rlimiter", ["rate"]));
    }

    return limiters;
  }

  /**
   * Build connection limiters
   */
  private static buildConnectionLimiter(connectionConfig: any, ruleId: number): GostLimiter[] {
    const limiters: GostLimiter[] = [];

    // Service-level connection limiting
    if (connectionConfig.service_limit !== undefined) {
      const limit = connectionConfig.service_limit || 0;
      limiters.push({
        name: `climiter-service-${ruleId}`,
        limits: [`$ ${limit}`],
      });
    }

    // IP-level connection limiting
    if (connectionConfig.ips && Array.isArray(connectionConfig.ips)) {
      limiters.push(...LimiterParser.buildIpLimiters(connectionConfig.ips, ruleId, "climiter", ["limit"]));
    }

    return limiters;
  }
}
