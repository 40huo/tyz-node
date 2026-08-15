/**
 * GOST configuration types (agent-side, consumed by the config builder)
 */

export interface GostConfig {
  services?: GostService[];
  chains?: any[];
  limiters?: any[];
  rlimiters?: any[];
  climiters?: any[];
  api?: any;
  observers?: any[];
  [key: string]: any;
}

export interface GostService {
  name: string;
  addr: string;
  handler: any;
  listener: any;
  [key: string]: any;
}
