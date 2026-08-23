/**
 * One-off: generate a fixed TLS material fixture for the Go agent tests
 * (apps/agent/internal/certs/testdata/fixture.json). The Go side parses the
 * PEMs with crypto/x509, builds the chain and asserts SAN/EKU — a cross-
 * language check that the Workers DER encoder emits valid certificates.
 *
 * Run inside apps/server: bun run scripts/gen-tls-fixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateTlsMaterial, type TlsProfile } from "../src/services/tls";

const PROFILE: TlsProfile = {
  ca_common_name: "Example Service CA",
  ca_organization: "example.com",
  ca_validity_days: 3650,
  leaf_validity_days: 365,
};

const outDir = new URL("../../../apps/agent/internal/certs/testdata/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const material = await generateTlsMaterial("relay.example.com", PROFILE);
const fixture = {
  sni: "relay.example.com",
  ca_cert: material.ca.cert_pem,
  server_cert: material.server.cert_pem,
  server_key: material.server.key_pem,
  client_cert: material.client.cert_pem,
  client_key: material.client.key_pem,
};
writeFileSync(`${outDir}/fixture.json`, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`fixture written to ${outDir}/fixture.json`);
