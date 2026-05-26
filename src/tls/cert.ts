import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { generate as generateCert } from "selfsigned";

export interface CertPaths {
  certPath: string;
  keyPath: string;
  metaPath?: string;
}

export interface SanSet {
  dns: string[];
  ip: string[];
}

export interface CertMaterial {
  cert: string;
  key: string;
  fingerprint: string;
  sans: SanSet;
  regenerated: boolean;
}

export interface EnsureCertOptions extends CertPaths {
  includeLanInterfaces?: boolean;
  extraHostnames?: string[];
  extraIps?: string[];
}

const LEGACY_DEFAULT_SANS: SanSet = {
  dns: ["localhost"],
  ip: ["127.0.0.1", "::1"],
};

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

function sha256Fingerprint(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const der = Buffer.from(body, "base64");
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  return (hex.match(/.{2}/g) ?? []).join(":");
}

function defaultMetaPath(certPath: string): string {
  return `${certPath}.meta.json`;
}

function lanInterfaceAddresses(): { ipv4: string[]; ipv6: string[] } {
  const ifaces = networkInterfaces();
  const ipv4 = new Set<string>();
  const ipv6 = new Set<string>();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const addr of list) {
      if (addr.internal) continue;
      if (addr.family === "IPv4") ipv4.add(addr.address);
      else if (addr.family === "IPv6" && !addr.address.toLowerCase().startsWith("fe80:")) {
        ipv6.add(addr.address);
      }
    }
  }
  return { ipv4: [...ipv4].sort(), ipv6: [...ipv6].sort() };
}

function collectDesiredSans(opts: {
  includeLanInterfaces: boolean;
  extraHostnames: readonly string[];
  extraIps: readonly string[];
}): SanSet {
  const dns = new Set<string>(LEGACY_DEFAULT_SANS.dns);
  const ip = new Set<string>(LEGACY_DEFAULT_SANS.ip);

  if (opts.includeLanInterfaces) {
    const host = hostname().trim();
    if (host) {
      dns.add(host);
      if (!host.endsWith(".local") && !host.includes(".")) {
        dns.add(`${host}.local`);
      }
    }
    const { ipv4, ipv6 } = lanInterfaceAddresses();
    for (const a of ipv4) ip.add(a);
    for (const a of ipv6) ip.add(a);
  }
  for (const h of opts.extraHostnames) {
    const v = h.trim();
    if (v) dns.add(v);
  }
  for (const a of opts.extraIps) {
    const v = a.trim();
    if (v) ip.add(v);
  }

  return {
    dns: [...dns].sort(),
    ip: [...ip].sort(),
  };
}

function isSubset(needed: SanSet, have: SanSet): boolean {
  const hd = new Set(have.dns);
  const hi = new Set(have.ip);
  return (
    needed.dns.every((d) => hd.has(d)) && needed.ip.every((x) => hi.has(x))
  );
}

function unionSans(a: SanSet, b: SanSet): SanSet {
  return {
    dns: [...new Set([...a.dns, ...b.dns])].sort(),
    ip: [...new Set([...a.ip, ...b.ip])].sort(),
  };
}

async function tryReadCert(
  certPath: string,
  keyPath: string,
): Promise<{ cert: string; key: string } | undefined> {
  try {
    const [cert, key] = await Promise.all([
      readFile(certPath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    if (!cert.includes("BEGIN CERTIFICATE") || !key.includes("PRIVATE KEY")) {
      return undefined;
    }
    return { cert, key };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function tryReadMeta(metaPath: string): Promise<SanSet | undefined> {
  try {
    const raw = await readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as { sans?: Partial<SanSet> };
    const dns = Array.isArray(parsed.sans?.dns) ? parsed.sans!.dns! : undefined;
    const ip = Array.isArray(parsed.sans?.ip) ? parsed.sans!.ip! : undefined;
    if (!dns || !ip) return undefined;
    return { dns: [...dns].sort(), ip: [...ip].sort() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function writeMeta(metaPath: string, sans: SanSet): Promise<void> {
  await mkdir(dirname(metaPath), { recursive: true });
  await writeFile(metaPath, `${JSON.stringify({ sans }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function toAltNames(sans: SanSet): Array<{ type: 2 | 7; value?: string; ip?: string }> {
  const out: Array<{ type: 2 | 7; value?: string; ip?: string }> = [];
  for (const d of sans.dns) out.push({ type: 2, value: d });
  for (const i of sans.ip) out.push({ type: 7, ip: i });
  return out;
}

export async function ensureCert(opts: EnsureCertOptions): Promise<CertMaterial> {
  const metaPath = opts.metaPath ?? defaultMetaPath(opts.certPath);
  const desired = collectDesiredSans({
    includeLanInterfaces: opts.includeLanInterfaces ?? false,
    extraHostnames: opts.extraHostnames ?? [],
    extraIps: opts.extraIps ?? [],
  });

  const existing = await tryReadCert(opts.certPath, opts.keyPath);
  const existingMeta = existing ? await tryReadMeta(metaPath) : undefined;

  if (existing) {
    const known = existingMeta ?? LEGACY_DEFAULT_SANS;
    if (isSubset(desired, known)) {
      if (!existingMeta) await writeMeta(metaPath, known);
      return {
        cert: existing.cert,
        key: existing.key,
        fingerprint: sha256Fingerprint(existing.cert),
        sans: known,
        regenerated: false,
      };
    }
  }

  const finalSans = existing
    ? unionSans(existingMeta ?? LEGACY_DEFAULT_SANS, desired)
    : desired;

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + 3650 * 24 * 60 * 60 * 1000);
  const generated = await generateCert(
    [{ name: "commonName", value: "localhost" }],
    {
      notBeforeDate,
      notAfterDate,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        {
          name: "subjectAltName",
          altNames: toAltNames(finalSans),
        },
      ],
    },
  );

  await mkdir(dirname(opts.certPath), { recursive: true });
  await mkdir(dirname(opts.keyPath), { recursive: true });
  await writeFile(opts.certPath, generated.cert, { encoding: "utf8", mode: 0o600 });
  await writeFile(opts.keyPath, generated.private, { encoding: "utf8", mode: 0o600 });
  await writeMeta(metaPath, finalSans);

  return {
    cert: generated.cert,
    key: generated.private,
    fingerprint: sha256Fingerprint(generated.cert),
    sans: finalSans,
    regenerated: true,
  };
}
