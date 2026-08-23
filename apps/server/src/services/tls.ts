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
import { eq, ne } from "drizzle-orm";
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
  /** Subject key identifier (SHA-1 of spki) — always set, like real issuers. */
  ski: Uint8Array;
  /** Authority key identifier — the issuer's ski (own ski on the self-signed CA). */
  aki: Uint8Array;
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
    // subjectKeyIdentifier / authorityKeyIdentifier: WebPKI certs essentially
    // always carry both — omitting them is a generator fingerprint.
    { oidText: "2.5.29.14", value: tlv(0x04, spec.ski) },
    { oidText: "2.5.29.35", value: tlv(0x30, tlv(0x80, spec.aki)) },
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

/** Minimal DER walking to pull a CA cert's SPKI back out (needed for the
 * leaf AKI when re-issuing under a stored CA). */
function readTLV(buf: Uint8Array, at: number): { tag: number; content: Uint8Array; raw: Uint8Array; next: number } {
  let pos = at;
  const start = pos;
  const tag = buf[pos++]!;
  let length = buf[pos++]!;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[pos++]!;
  }
  const end = pos + length;
  return { tag, content: buf.subarray(pos, end), raw: buf.subarray(start, end), next: end };
}

/** Certificate -> tbsCertificate -> subjectPublicKeyInfo (7th field, raw TLV). */
function spkiFromCertDer(der: Uint8Array): Uint8Array {
  let node = readTLV(der, 0);
  if (node.tag !== 0x30) throw new Error("certificate is not a SEQUENCE");
  node = readTLV(node.content, 0); // tbsCertificate
  if (node.tag !== 0x30) throw new Error("missing tbsCertificate");
  let at = 0;
  for (let i = 0; i < 6; i++) at = readTLV(node.content, at).next; // skip to field 7
  return readTLV(node.content, at).raw;
}

/** RFC 5280 method-1 key identifier: SHA-1 of the public key's SPKI. */
async function keyIdentifier(spki: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", spki));
}

// ---- Certificate issuance ----

// ---- Certificate profile (admin-configurable) ----

const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const DAY_MS = 86_400_000;
/** Fallback for deployments whose CA predates the configurable profile. */
const LEGACY_CA_CN = "TYZ Relay CA";
const LEGACY_CA_ORG = "TYZ";
const DEFAULT_CA_VALIDITY_DAYS = 3650;
const DEFAULT_LEAF_VALIDITY_DAYS = 365;

export type MaterialKind = "ca" | "server" | "client";

/**
 * The observable certificate profile. CA identity strings are what a probe
 * reads off every leaf's issuer DN, so they must not be a fleet-wide constant:
 * unset values derive from the disguise domain (per-deployment unique) and the
 * admin can override each field.
 */
export interface TlsProfile {
  ca_common_name: string;
  /** "" = omit the O attribute entirely. */
  ca_organization: string;
  ca_validity_days: number;
  leaf_validity_days: number;
}

/** app_settings keys — persisted with the effective values whenever material is issued. */
const PROFILE_KEYS = {
  ca_common_name: "tls_ca_common_name",
  ca_organization: "tls_ca_organization",
  ca_validity_days: "tls_ca_validity_days",
  leaf_validity_days: "tls_leaf_validity_days",
} as const;

function derivedCaCommonName(domain: string): string {
  return `${domain} CA`;
}

/** Rough registrable domain (last two labels) — a neutral per-deployment O. */
function derivedCaOrganization(domain: string): string {
  const labels = domain.split(".");
  return labels.length <= 2 ? domain : labels.slice(-2).join(".");
}

async function readSettings(db: Database): Promise<Map<string, string>> {
  const rows = await db.select().from(appSettings).all();
  return new Map(rows.map((row) => [row.key, row.value]));
}

/**
 * The profile in effect for the material generation/renewal paths: stored
 * values win; a legacy deployment (material exists, keys absent) keeps its
 * hardcoded identity so re-issued leaves keep byte-identical issuer DNs;
 * fresh deployments derive neutral defaults from the domain.
 */
export async function resolveTlsProfile(
  db: Database,
  domain: string | null,
  materialExists: boolean,
): Promise<TlsProfile> {
  const settings = await readSettings(db);
  const org = settings.get(PROFILE_KEYS.ca_organization);
  const caDays = Number(settings.get(PROFILE_KEYS.ca_validity_days));
  const leafDays = Number(settings.get(PROFILE_KEYS.leaf_validity_days));
  const effectiveDomain = domain ?? "";
  return {
    ca_common_name:
      settings.get(PROFILE_KEYS.ca_common_name) ??
      (materialExists ? LEGACY_CA_CN : derivedCaCommonName(effectiveDomain)),
    ca_organization: org !== undefined ? org : materialExists ? LEGACY_CA_ORG : derivedCaOrganization(effectiveDomain),
    ca_validity_days: Number.isFinite(caDays) && caDays > 0 ? caDays : DEFAULT_CA_VALIDITY_DAYS,
    leaf_validity_days: Number.isFinite(leafDays) && leafDays > 0 ? leafDays : DEFAULT_LEAF_VALIDITY_DAYS,
  };
}

async function persistProfileKeys(db: Database, profile: TlsProfile): Promise<void> {
  const ts = new Date().toISOString();
  for (const [key, value] of Object.entries({
    [PROFILE_KEYS.ca_common_name]: profile.ca_common_name,
    [PROFILE_KEYS.ca_organization]: profile.ca_organization,
    [PROFILE_KEYS.ca_validity_days]: String(profile.ca_validity_days),
    [PROFILE_KEYS.leaf_validity_days]: String(profile.leaf_validity_days),
  })) {
    await db
      .insert(appSettings)
      .values({ key, value, updated_at: ts })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updated_at: ts } });
  }
}

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
  ski: Uint8Array;
  aki: Uint8Array;
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
    ski: opts.ski,
    aki: opts.aki,
    isCA: opts.isCA,
    sanDns: opts.sanDns,
    ekuOid: opts.ekuOid,
  });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, opts.signKey, tbs);
  const cert = tlv(0x30, concat(tbs, sigAlgorithm(), bitString(ecdsaRawToDer(signature), 0)));
  return { certPem: pemEncode("CERTIFICATE", cert), keyPem: "", notAfter: notAfter.toISOString() };
}

/** Full generation: CA + both leaves (fresh CA keypair). No DB access. */
export async function generateTlsMaterial(
  domain: string,
  profile: TlsProfile,
): Promise<Record<MaterialKind, MaterialRow>> {
  const caKeys = await generateKeyPair();
  const caSpki = await exportDer(caKeys.publicKey, "spki");
  const caKeyPem = pemEncode("PRIVATE KEY", await exportDer(caKeys.privateKey, "pkcs8"));
  const caSki = await keyIdentifier(caSpki);
  const caName = name(profile.ca_common_name, profile.ca_organization || undefined);

  const ca = await issueCertificate({
    signKey: caKeys.privateKey,
    issuerName: caName,
    subjectName: caName,
    spki: caSpki,
    ski: caSki,
    aki: caSki, // self-signed: AKI == SKI
    isCA: true,
    validityDays: profile.ca_validity_days,
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
      const leaf = await issueLeaf(kind, domain, profile, caRow, caName, caSki);
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

/** Re-issue one leaf under the existing CA (renewal / domain change). The
 * issuer DN must byte-match the stored CA's subject, so the profile must
 * resolve to the same identity the CA was issued with (see resolveTlsProfile). */
async function issueLeaf(
  kind: "server" | "client",
  domain: string,
  profile: TlsProfile,
  ca: Pick<MaterialRow, "cert_pem" | "key_pem">,
  caName?: Uint8Array,
  caAki?: Uint8Array,
): Promise<{ certPem: string; keyPem: string; notAfter: string }> {
  const issuer = caName ?? name(profile.ca_common_name, profile.ca_organization || undefined);
  const aki = caAki ?? (await keyIdentifier(spkiFromCertDer(pemDecode(ca.cert_pem))));
  const caKey = await importSigningKey(ca.key_pem);
  const leafKeys = await generateKeyPair();
  const spki = await exportDer(leafKeys.publicKey, "spki");
  const keyPem = pemEncode("PRIVATE KEY", await exportDer(leafKeys.privateKey, "pkcs8"));
  const issued = await issueCertificate({
    signKey: caKey,
    issuerName: issuer,
    // client.{domain} reads as a service hostname, not a "-client" literal
    // (the client cert is wire-invisible under TLS 1.3, but stay neutral).
    subjectName: name(kind === "server" ? domain : `client.${domain}`),
    spki,
    ski: await keyIdentifier(spki),
    aki,
    isCA: false,
    sanDns: kind === "server" ? domain : undefined,
    ekuOid: kind === "server" ? EKU_SERVER_AUTH : EKU_CLIENT_AUTH,
    validityDays: profile.leaf_validity_days,
  });
  return { certPem: issued.certPem, keyPem, notAfter: issued.notAfter };
}

// ---- DB access ----

export const TLS_DOMAIN_KEY = "tls_domain";

export async function getTlsDomain(db: Database): Promise<string | null> {
  const row = await db.select().from(appSettings).where(eq(appSettings.key, TLS_DOMAIN_KEY)).get();
  return row?.value ?? null;
}

/**
 * Set the platform-wide disguise domain. Returns whether the value actually
 * changed and whether this save issued material from nothing. A same-value
 * write is a pure no-op; a real change re-issues eagerly — with an existing
 * CA it re-issues the dropped server leaf, with no material at all it issues
 * the full set under the new domain. Settings saves never leave certs
 * "pending until the first TLS tunnel".
 */
export async function setTlsDomain(db: Database, domain: string): Promise<{ changed: boolean; issued: boolean }> {
  const row = await db.select().from(appSettings).where(eq(appSettings.key, TLS_DOMAIN_KEY)).get();
  if (row?.value === domain) return { changed: false, issued: false };
  await db
    .insert(appSettings)
    .values({ key: TLS_DOMAIN_KEY, value: domain, updated_at: new Date().toISOString() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: domain, updated_at: new Date().toISOString() } });
  await db.delete(tlsMaterial).where(eq(tlsMaterial.kind, "server"));
  const hadCa = (await loadMaterial(db)).has("ca");
  await ensureTlsMaterial(db);
  return { changed: true, issued: !hadCa };
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
  const materialExists = rows.size > 0;
  const profile = await resolveTlsProfile(db, domain, materialExists);
  if (!rows.has("ca") || !rows.has("server") || !rows.has("client")) {
    if (!rows.has("ca")) {
      // Fresh platform (or wiped material): one shot generates everything.
      const fresh = await generateTlsMaterial(domain, profile);
      for (const row of Object.values(fresh)) await insertMaterialIfAbsent(db, row);
    } else {
      // CA exists but a leaf is missing (e.g. domain change dropped the server
      // cert): re-issue the missing leaf under the existing CA.
      const ca = rows.get("ca")!;
      for (const kind of ["server", "client"] as const) {
        if (rows.has(kind)) continue;
        const leaf = await issueLeaf(kind, domain, profile, ca);
        await insertMaterialIfAbsent(db, {
          kind,
          cert_pem: leaf.certPem,
          key_pem: leaf.keyPem,
          not_after: leaf.notAfter,
          updated_at: new Date().toISOString(),
        });
      }
    }
    // Record the effective profile so later writes can diff against it.
    await persistProfileKeys(db, profile);
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

  const profile = await resolveTlsProfile(db, domain, true);
  const now = Date.now();
  const ca = rows.get("ca")!;
  if (Date.parse(ca.not_after) < now + 90 * DAY_MS) {
    await db.delete(tlsMaterial);
    const fresh = await generateTlsMaterial(domain, profile);
    for (const row of Object.values(fresh)) await insertMaterialIfAbsent(db, row);
    await persistProfileKeys(db, profile);
    return true;
  }

  let changed = false;
  for (const kind of ["server", "client"] as const) {
    const row = rows.get(kind)!;
    if (Date.parse(row.not_after) < now + 30 * DAY_MS) {
      const leaf = await issueLeaf(kind, domain, profile, ca);
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

/**
 * Apply admin profile edits, generating material eagerly. With no material
 * stored yet the full set is issued right away ("issued" — a settings save
 * never leaves certs pending until the first TLS tunnel). Otherwise: changing
 * CA identity fields (CN/O/CA validity) rotates the whole set — new trust
 * anchor, agents converge via the ordinary recompute+push cycle (brief link
 * disruption while entry and exit swap); changing only the leaf validity
 * re-issues the leaves under the existing CA ("leaves"); a no-op write
 * leaves the material untouched ("none").
 */
export async function setTlsProfile(
  db: Database,
  input: {
    ca_common_name?: string;
    ca_organization?: string;
    ca_validity_days?: number;
    leaf_validity_days?: number;
  },
): Promise<{ profile: TlsProfile; regenerated: "all" | "leaves" | "issued" | "none" }> {
  const domain = await getTlsDomain(db);
  const rows = await loadMaterial(db);
  const materialExists = rows.has("ca");
  const current = await resolveTlsProfile(db, domain, materialExists);
  const next: TlsProfile = {
    ca_common_name: input.ca_common_name ?? current.ca_common_name,
    ca_organization: input.ca_organization !== undefined ? input.ca_organization : current.ca_organization,
    ca_validity_days: input.ca_validity_days ?? current.ca_validity_days,
    leaf_validity_days: input.leaf_validity_days ?? current.leaf_validity_days,
  };
  await persistProfileKeys(db, next);
  if (!domain) {
    // No domain yet — nothing can be issued; the keys apply at the next save.
    return { profile: next, regenerated: "none" };
  }
  if (!materialExists) {
    await ensureTlsMaterial(db);
    return { profile: next, regenerated: "issued" };
  }
  const caIdentityChanged =
    next.ca_common_name !== current.ca_common_name ||
    next.ca_organization !== current.ca_organization ||
    next.ca_validity_days !== current.ca_validity_days;
  if (caIdentityChanged) {
    await db.delete(tlsMaterial);
  } else if (next.leaf_validity_days !== current.leaf_validity_days) {
    await db.delete(tlsMaterial).where(ne(tlsMaterial.kind, "ca"));
  } else {
    return { profile: next, regenerated: "none" };
  }
  await ensureTlsMaterial(db);
  return { profile: next, regenerated: caIdentityChanged ? "all" : "leaves" };
}

/** Expiry metadata + effective profile for the admin panel — never PEM/key material. */
export async function getTlsStatus(db: Database): Promise<{
  domain: string | null;
  ca_not_after: string | null;
  server_not_after: string | null;
  client_not_after: string | null;
  profile: TlsProfile;
}> {
  const [domain, rows] = await Promise.all([getTlsDomain(db), loadMaterial(db)]);
  const profile = await resolveTlsProfile(db, domain, rows.size > 0);
  return {
    domain,
    ca_not_after: rows.get("ca")?.not_after ?? null,
    server_not_after: rows.get("server")?.not_after ?? null,
    client_not_after: rows.get("client")?.not_after ?? null,
    profile,
  };
}
