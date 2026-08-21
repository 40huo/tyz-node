/**
 * One-off: generate a fixed TLS material fixture for the Go agent tests
 * (apps/agent/internal/certs/testdata/fixture.json). The Go side parses the
 * PEMs with crypto/x509, builds the chain and asserts SAN/EKU — a cross-
 * language check that the Workers DER encoder emits valid certificates.
 *
 * Run inside apps/server: bun run scripts/gen-tls-fixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateTlsMaterial } from "../src/services/tls";

const outDir = new URL("../../../apps/agent/internal/certs/testdata/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const material = await generateTlsMaterial("relay.example.com");
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
