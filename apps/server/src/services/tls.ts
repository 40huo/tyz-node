/**
 * Platform link-TLS material: a self-signed ECDSA P-256 CA plus server/client
 * leaf certificates, generated in-process. Workers ships no X.509 library, so
 * this file contains a minimal DER encoder covering exactly what an RFC 5280
 * certificate needs (the SubjectPublicKeyInfo is embedded raw from WebCrypto,
 * which keeps all EC point math out of here).
 *
 * Storage: PEM text rows in tls_material (kind = ca|server|client). Delivery:
 * exclusively through the authenticated agent config payload — the PEMs are
 * secrets of the same trust domain as node tokens and must never appear in
 * admin responses or the audit log.
 */
import type { TlsMaterial } from "@tyz/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { appSettings, tlsMaterial } from "../db/schema";

// ---- DER primitives ----

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Tag-Length-Value with minimal DER length encoding. */
function tlv(tag: number, content: Uint8Array): Uint8Array {
  let head: number[];
  if (content.length < 0x80) {
    head = [content.length];
  } else {
    const bytes: number[] = [];
    let n = content.length;
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n >>= 8;
    }
    head = [0x80 | bytes.length, ...bytes];
  }
  const out = new Uint8Array(1 + head.length + content.length);
  out[0] = tag;
  out.set(head, 1);
  out.set(content, 1 + head.length);
  return out;
}

/** OID from dotted decimal, e.g. "1.2.840.10045.4.3.2". */
function oid(text: string): Uint8Array {
  const arcs = text.split(".").map(Number);
  const body: number[] = [40 * arcs[0] + arcs[1]];
  for (let i = 2; i < arcs.length; i++) {
    let v = arcs[i];
    const stack: number[] = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    body.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(body));
}

/** INTEGER content normalization: no leading zeros, positive numbers get a
 * guard 0x00 when the high bit is set (RFC 5280 serials/ECDSA r,s). */
function intContent(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const b = bytes.subarray(i);
  if (b.length > 0 && b[0]! & 0x80) return concat(Uint8Array.of(0), b);
  return b.length > 0 ? b : Uint8Array.of(0);
}

function intTag(bytes: Uint8Array): Uint8Array {
  return tlv(0x02, intContent(bytes));
}

function utf8String(text: string): Uint8Array {
  return tlv(0x0c, encoder.encode(text));
}

function utcTime(date: Date): Uint8Array {
  const p = (n: number) => String(n).padStart(2, "0");
  const text = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, encoder.encode(text));
}

function bitString(data: Uint8Array, unusedBits: number): Uint8Array {
  return tlv(0x03, concat(Uint8Array.of(unusedBits), data));
}

/** RDNSequence with O (2.5.4.10) + CN (2.5.4.3), the only attributes we use. */
function name(cn: string, org?: string): Uint8Array {
  const rdns: Uint8Array[] = [];
  if (org) rdns.push(tlv(0x31, tlv(0x30, concat(oid("2.5.4.10"), utf8String(org)))));
  rdns.push(tlv(0x31, tlv(0x30, concat(oid("2.5.4.3"), utf8String(cn)))));
  return tlv(0x30, concat(...rdns));
}

const SIG_ALG_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const sigAlgorithm = () => tlv(0x30, oid(SIG_ALG_ECDSA_SHA256));

interface Extension {
  oidText: string;
  critical?: boolean;
  value: Uint8Array;
}

function extension(ext: Extension): Uint8Array {
  const parts = [oid(ext.oidText)];
  if (ext.critical) parts.push(tlv(0x01, Uint8Array.of(0xff)));
  parts.push(tlv(0x04, ext.value));
  return tlv(0x30, concat(...parts));
}

/** keyUsage bit content: bit0 = digitalSignature (0x80), bit5 = keyCertSign
 * (0x04), bit6 = cRLSign (0x02); trailing zero bits are dropped per DER. */
function keyUsage(bits: number): Uint8Array {
  let used = 0;
  for (let bit = 0; bit < 8; bit++) {
    if (bits & (0x80 >> bit)) used = bit + 1;
  }
  return bitString(Uint8Array.of(bits), 8 - used);
}

interface TbsSpec {
  serial: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  /** Raw SubjectPublicKeyInfo DER (exportKey("spki")) — embedded verbatim. */
  spki: Uint8Array;
  isCA: boolean;
  /** dNSName GeneralName for subjectAltName (leaves only). */
  sanDns?: string;
  /** EKU OID (serverAuth / clientAuth). */
  ekuOid?: string;
}

function buildTbs(spec: TbsSpec): Uint8Array {
  const extensions: Extension[] = [
    // basicConstraints: critical, cA true (with pathLen absent) or false.
    {
      oidText: "2.5.29.19",
      critical: true,
      value: spec.isCA ? tlv(0x30, tlv(0x01, Uint8Array.of(0xff))) : tlv(0x30, new Uint8Array(0)),
    },
    {
      oidText: "2.5.29.15",
      critical: true,
      value: keyUsage(spec.isCA ? 0x06 : 0x80), // keyCertSign|cRLSign vs digitalSignature
    },
  ];
  if (spec.sanDns) {
    extensions.push({ oidText: "2.5.29.17", value: tlv(0x30, tlv(0x82, encoder.encode(spec.sanDns))) });
  }
  if (spec.ekuOid) {
    extensions.push({ oidText: "2.5.29.37", value: tlv(0x30, oid(spec.ekuOid)) });
  }
  const validity = tlv(0x30, concat(utcTime(spec.notBefore), utcTime(spec.notAfter)));
  return tlv(
    0x30,
    concat(
      tlv(0xa0, intTag(Uint8Array.of(2))), // [0] EXPLICIT version v3
      intTag(spec.serial),
      sigAlgorithm(),
      spec.issuer,
      validity,
      spec.subject,
      spec.spki,
      tlv(0xa3, tlv(0x30, concat(...extensions.map(extension)))),
    ),
  );
}

/** WebCrypto returns raw r||s (2 × curve size); certificates need the DER
 * SEQUENCE { r INTEGER, s INTEGER } form. */
function ecdsaRawToDer(raw: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(raw);
  const half = bytes.length / 2;
  return tlv(0x30, concat(intTag(bytes.subarray(0, half)), intTag(bytes.subarray(half))));
}

// ---- PEM ----

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function pemEncode(label: string, der: Uint8Array): string {
  const lines = toBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function pemDecode(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---- Certificate issuance ----

const CA_CN = "TYZ Relay CA";
const CA_ORG = "TYZ";
const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const DAY_MS = 86_400_000;
const CA_VALIDITY_DAYS = 3650;
const LEAF_VALIDITY_DAYS = 365;

export type MaterialKind = "ca" | "server" | "client";

export interface MaterialRow {
  kind: MaterialKind;
  cert_pem: string;
  key_pem: string;
  not_after: string;
  updated_at: string;
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function importSigningKey(keyPem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pemDecode(keyPem), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
}

/** Export a public/private key as raw DER (the DOM types widen pkcs8 to
 * ArrayBuffer | JsonWebKey; we only ever export extractable binary keys). */
async function exportDer(key: CryptoKey, format: "spki" | "pkcs8"): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey(format, key)) as ArrayBuffer);
}

function randomSerial(): Uint8Array {
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f; // keep positive; avoid a leading 0x00-only serial
  if (serial[0] === 0) serial[0] = 1;
  return serial;
}

async function issueCertificate(opts: {
  signKey: CryptoKey;
  issuerName: Uint8Array;
  subjectName: Uint8Array;
  spki: Uint8Array;
  isCA: boolean;
  sanDns?: string;
  ekuOid?: string;
  validityDays: number;
}): Promise<{ certPem: string; keyPem: string; notAfter: string }> {
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + opts.validityDays * DAY_MS);
  const tbs = buildTbs({
    serial: randomSerial(),
    issuer: opts.issuerName,
    subject: opts.subjectName,
    notBefore,
    notAfter,
    spki: opts.spki,
    isCA: opts.isCA,
    sanDns: opts.sanDns,
    ekuOid: opts.ekuOid,
  });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, opts.signKey, tbs);
  const cert = tlv(0x30, concat(tbs, sigAlgorithm(), bitString(ecdsaRawToDer(signature), 0)));
  return { certPem: pemEncode("CERTIFICATE", cert), keyPem: "", notAfter: notAfter.toISOString() };
}

/** Full generation: CA + both leaves (fresh CA keypair). No DB access. */
export async function generateTlsMaterial(domain: string): Promise<Record<MaterialKind, MaterialRow>> {
  const caKeys = await generateKeyPair();
  const caSpki = await exportDer(caKeys.publicKey, "spki");
  const caKeyPem = pemEncode("PRIVATE KEY", await exportDer(caKeys.privateKey, "pkcs8"));
  const caName = name(CA_CN, CA_ORG);

  const ca = await issueCertificate({
    signKey: caKeys.privateKey,
    issuerName: caName,
    subjectName: caName,
    spki: caSpki,
    isCA: true,
    validityDays: CA_VALIDITY_DAYS,
  });
  const caRow: MaterialRow = {
    kind: "ca",
    cert_pem: ca.certPem,
    key_pem: caKeyPem,
    not_after: ca.notAfter,
    updated_at: new Date().toISOString(),
  };

  const rows = await Promise.all(
    (["server", "client"] as const).map(async (kind) => {
      const leaf = await issueLeaf(kind, domain, caRow, caName);
      return {
        kind,
        cert_pem: leaf.certPem,
        key_pem: leaf.keyPem,
        not_after: leaf.notAfter,
        updated_at: new Date().toISOString(),
      } satisfies MaterialRow;
    }),
  );
  return { ca: caRow, server: rows[0], client: rows[1] };
}

/** Re-issue one leaf under the existing CA (renewal / domain change). */
async function issueLeaf(
  kind: "server" | "client",
  domain: string,
  ca: Pick<MaterialRow, "cert_pem" | "key_pem">,
  caName?: Uint8Array,
): Promise<{ certPem: string; keyPem: string; notAfter: string }> {
  const issuer = caName ?? name(CA_CN, CA_ORG);
  const caKey = await importSigningKey(ca.key_pem);
  const leafKeys = await generateKeyPair();
  const spki = await exportDer(leafKeys.publicKey, "spki");
  const keyPem = pemEncode("PRIVATE KEY", await exportDer(leafKeys.privateKey, "pkcs8"));
  const issued = await issueCertificate({
    signKey: caKey,
    issuerName: issuer,
    subjectName: name(kind === "server" ? domain : `${domain}-client`),
    spki,
    isCA: false,
    sanDns: kind === "server" ? domain : undefined,
    ekuOid: kind === "server" ? EKU_SERVER_AUTH : EKU_CLIENT_AUTH,
    validityDays: LEAF_VALIDITY_DAYS,
  });
  return { certPem: issued.certPem, keyPem, notAfter: issued.notAfter };
}

// ---- DB access ----

export const TLS_DOMAIN_KEY = "tls_domain";

export async function getTlsDomain(db: Database): Promise<string | null> {
  const row = await db.select().from(appSettings).where(eq(appSettings.key, TLS_DOMAIN_KEY)).get();
  return row?.value ?? null;
}

export async function setTlsDomain(db: Database, domain: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: TLS_DOMAIN_KEY, value: domain })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: domain, updated_at: new Date().toISOString() } });
  // The server cert embeds the domain as SAN/CN — drop it so the next
  // aggregation re-issues it (and the config diff pushes it to agents).
  await db.delete(tlsMaterial).where(eq(tlsMaterial.kind, "server"));
}

async function loadMaterial(db: Database): Promise<Map<MaterialKind, MaterialRow>> {
  const rows = await db.select().from(tlsMaterial).all();
  return new Map(rows.map((row) => [row.kind as MaterialKind, row as MaterialRow]));
}

async function insertMaterialIfAbsent(db: Database, row: MaterialRow): Promise<void> {
  await db.insert(tlsMaterial).values(row).onConflictDoNothing();
}

/**
 * Load-or-generate the complete material set for `domain`. Throws when the
 * domain is unset — the admin write path surfaces that to the panel.
 */
export async function ensureTlsMaterial(db: Database): Promise<TlsMaterial> {
  const domain = await getTlsDomain(db);
  if (!domain) throw new Error("tls_domain is not configured");

  let rows = await loadMaterial(db);
  if (!rows.has("ca") || !rows.has("server") || !rows.has("client")) {
    if (!rows.has("ca")) {
      // Fresh platform (or wiped material): one shot generates everything.
      const fresh = await generateTlsMaterial(domain);
      for (const row of Object.values(fresh)) await insertMaterialIfAbsent(db, row);
    } else {
      // CA exists but a leaf is missing (e.g. domain change dropped the server
      // cert): re-issue the missing leaf under the existing CA.
      const ca = rows.get("ca")!;
      for (const kind of ["server", "client"] as const) {
        if (rows.has(kind)) continue;
        const leaf = await issueLeaf(kind, domain, ca);
        await insertMaterialIfAbsent(db, {
          kind,
          cert_pem: leaf.certPem,
          key_pem: leaf.keyPem,
          not_after: leaf.notAfter,
          updated_at: new Date().toISOString(),
        });
      }
    }
    rows = await loadMaterial(db);
  }

  const ca = rows.get("ca");
  const server = rows.get("server");
  const client = rows.get("client");
  if (!ca || !server || !client) throw new Error("tls material generation failed");
  return {
    sni: domain,
    ca_cert: ca.cert_pem,
    server_cert: server.cert_pem,
    server_key: server.key_pem,
    client_cert: client.cert_pem,
    client_key: client.key_pem,
  };
}

/**
 * Renew material nearing expiry (called by the daily cron): leaves with <30d
 * left are re-issued under the existing CA; when the CA itself drops below 90d
 * the whole set is regenerated together. Returns true when anything changed
 * (the caller recomputes node configs so agents pick up new PEMs).
 */
export async function renewTlsMaterial(db: Database): Promise<boolean> {
  const domain = await getTlsDomain(db);
  if (!domain) return false;

  const rows = await loadMaterial(db);
  if (!rows.has("ca") || !rows.has("server") || !rows.has("client")) return false;

  const now = Date.now();
  const ca = rows.get("ca")!;
  if (Date.parse(ca.not_after) < now + 90 * DAY_MS) {
    await db.delete(tlsMaterial);
    const fresh = await generateTlsMaterial(domain);
    for (const row of Object.values(fresh)) await insertMaterialIfAbsent(db, row);
    return true;
  }

  let changed = false;
  for (const kind of ["server", "client"] as const) {
    const row = rows.get(kind)!;
    if (Date.parse(row.not_after) < now + 30 * DAY_MS) {
      const leaf = await issueLeaf(kind, domain, ca);
      await db
        .update(tlsMaterial)
        .set({
          cert_pem: leaf.certPem,
          key_pem: leaf.keyPem,
          not_after: leaf.notAfter,
          updated_at: new Date().toISOString(),
        })
        .where(eq(tlsMaterial.kind, kind));
      changed = true;
    }
  }
  return changed;
}

/** Expiry metadata for the admin panel — never includes PEM/key material. */
export async function getTlsStatus(db: Database): Promise<{
  domain: string | null;
  ca_not_after: string | null;
  server_not_after: string | null;
  client_not_after: string | null;
}> {
  const [domain, rows] = await Promise.all([getTlsDomain(db), loadMaterial(db)]);
  return {
    domain,
    ca_not_after: rows.get("ca")?.not_after ?? null,
    server_not_after: rows.get("server")?.not_after ?? null,
    client_not_after: rows.get("client")?.not_after ?? null,
  };
}
