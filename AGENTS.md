# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

TYZ Node is a GOST (GO Simple Tunnel) configuration wrapper service that converts database configurations from Supabase into GOST JSON format. The service listens to database changes via Supabase Realtime, transforms the data, and hot-reloads GOST configurations through its API.

**Stack**: Bun + Hono + Supabase + GOST v3.2.6

## Common Commands

```bash
# Development
bun install                  # Install dependencies
bun run dev                  # Start development server with hot reload
bun run start                # Production server

# Testing
bun run test                 # Full integration test (requires GOST binary at /home/guyuels/workspace/laoshan/gost-binary/gost)
bun run type-check           # TypeScript type checking

# Building
bun run build                # Compile to standalone binary in dist/server

# Linting & Formatting
bun run type-check           # TypeScript type checking
# Biome is configured for linting/formatting (double quotes, 120 char width)
```

## Architecture Overview

### Data Flow
```
Supabase Database (schema=node)
    ↓ (Realtime subscription)
Edge Function (aggregates data from multiple tables)
    ↓ (writes to gost_node_configs table)
This Service (listens to config table changes)
    ↓ (converts to GOST format)
GOST API (hot-reload configuration)
```

### Core Components

**Config Builder** (`src/services/gost/builder.ts`):
- `GOSTConfigBuilder`: Main class that orchestrates configuration generation
- `ServiceNaming`: Centralized naming factory for services, chains, hops, nodes
- Entry point: `generateGostConfig(data: NodeConfigData): GostConfig`

**Transport Mapping** (`src/services/gost/mapper.ts`):
- Maps database transport types to GOST dialer/connector types
- `raw→tcp, tls→tls, wss→ws, mwss→mws`, etc.
- `PortAllocator`: Hash-based auto port allocation when `chain.port = 0`

**Limiter Parser** (`src/services/gost/limiter.ts`):
- Parses JSON `limit` field from `relay_rules` table
- Generates three types: `limiters` (traffic), `rlimiters` (request rate), `climiters` (connection)
- Supports service-level and per-IP limits

**TLS Generator** (`src/services/gost/tls.ts`):
- Generates TLS certificate configuration from optional `tls` field

**Supabase Service** (`src/services/supabase.ts`):
- Manages Realtime subscription to config table
- Triggers config conversion and GOST update on database changes
- Saves GOST observer statistics back to database

**GOST Client** (`src/services/gost/client.ts`):
- HTTP client for GOST API (v3.2.6)
- `updateConfig()`: POST /api/config/reload with the new config as body, for hot-reload
- `getConfig()`: Fetch current config state

## Critical Implementation Details

### Database Schema Quirks

**Typo in field names** (preserved from database):
- `relay_nodes.disaply_address` (NOT display_address)
- `tunnels.ingress_disaply_address` (NOT ingress_display_address)

**Enum types are strings**:
- `chain_type`: `'in'`, `'chain'`, `'out'` (not numeric)
- `transport`: `'raw'`, `'ws'`, `'tls'`, `'grpc'`, `'wss'`, `'mtls'`, `'mwss'`
- `status`: `'created'`, `'paused'`, `'running'`, `'error'`

**Limiter config is JSON object**:
- `relay_rules.limit` is stored as JSON (type: `LimiterConfig`), not string
- Structure: `{ traffic?: {...}, request?: {...}, connection?: {...} }`

**Different traffic field names**:
- `relay_nodes`: uses `egress_traffic` / `ingress_traffic`
- `relay_rules`: uses `upload_traffic` / `download_traffic`

### Service Generation Logic

The service builder determines handler/listener types based on:

1. **Node position in tunnel** (IN/CHAIN/OUT from `chain_type`)
2. **Chain hop count** (single/two/multi-hop)

**Entry nodes** (chain_type='in'):
- 1 hop: Simple forwarding → `handler: tcp, listener: tcp, forwarder`
- 2 hops: Relay with chain → `handler: tcp + chain, listener: tcp, forwarder`
- 3+ hops: Auto handler → `handler: auto + chain, listener: tcp`

**Exit nodes** (chain_type='out'):
- Always use `handler: relay` with transport-based listener
- Port comes from chain's `port` field (or auto-allocated)

### Chain Generation

**Only generated at entry nodes** (where chain_type='in' for current node).

**Two-hop chains**:
- Single hop with `connector: relay`
- Points to exit node address

**Multi-hop chains** (3+ nodes):
- Multiple hops, one per chain record (sorted by `index`)
- Each hop has connector based on `chain_type`
- Supports custom `selector.strategy` per hop

### Port Allocation

When `chain.port = 0`, auto-allocate from node's port range:
```typescript
allocated_port = start + (chain_id + node_id) % port_range
```
Parse range from `relay_nodes.ports` (e.g., "10000-20000")

## Type Definitions

**Input**: `NodeConfigData` (`src/types/database.ts`)
- Aggregated data from Supabase tables: `node`, `rules`, `tunnels`, `chains`, optional `tls`

**Output**: `GostConfig` (`src/types/gost.ts`)
- GOST v3 configuration format with `services`, `chains`, `limiters`, `rlimiters`, `climiters`, `tls`

## Testing Strategy

**Full integration test** (`bun run test`, runs `scripts/test-full-integration.ts`):
- Starts actual GOST v3.2.6 process
- Applies generated config via API
- Verifies services, chains, limiters are running
- Checks port listening and connections
- Requires GOST binary at `/home/guyuels/workspace/laoshan/gost-binary/gost`

**Auth test script**: `scripts/test-supabase-token-auth.ts`
- Tests Supabase Edge Function authentication
- Not exposed in package.json, run directly with `bun run scripts/test-supabase-token-auth.ts`

## Configuration Hot-Reload

GOST v3 supports hot-reload via API (preferred over file + restart):
```typescript
// Recommended approach
await gostClient.updateConfig(newConfig)
```

Do NOT restart GOST process for config updates unless API is unavailable.

## Environment Variables

Required in `.env`:
- `GOST_API_URL`: GOST API endpoint (default: http://localhost:18080)
- `SUPABASE_URL`, `SUPABASE_KEY`: Supabase project credentials
- `SUPABASE_TABLE`: Config table name to subscribe to
- `NODE_ID`: Identifier for this node instance
- `PORT`: HTTP server port (default: 18090)
- `HOST`: HTTP server host (default: 127.0.0.1)
- `DEBUG`: Enable verbose logging

## Path Alias

TypeScript path alias configured: `@/*` → `./src/*`

Use imports like:
```typescript
import { logger } from '@/utils/logger';
import type { GostConfig } from '@/types/gost';
```

## HTTP Endpoints

- `GET /health`: Health check
- `POST /gost/config/update`: Update GOST configuration from database format
- `POST /gost/observer`: Receive GOST observer stats callbacks

## GOST Configuration Template

The `config/gost.json` file provides the base GOST configuration with:
- API endpoint at `localhost:18080` with `/api` path prefix
- Observer plugin configured to POST stats to `http://localhost:18090/gost/observer`
- Empty services array (populated dynamically by this service)

## Code Style

This project uses **Biome** for linting and formatting:
- Double quotes for strings
- 120 character line width
- Space indentation
- Auto-import organization on save

Run `bun run type-check` for TypeScript validation.

## Documentation Files

- `examples/real-database-example.json`: Real database structure example
