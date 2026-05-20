import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generate as generateCert } from "selfsigned";

export interface CertPaths {
  certPath: string;
  keyPath: string;
}

export interface CertMaterial {
  cert: string;
  key: string;
  fingerprint: string;
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

async function tryRead(certPath: string, keyPath: string): Promise<CertMaterial | undefined> {
  try {
    const [cert, key] = await Promise.all([
      readFile(certPath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    if (!cert.includes("BEGIN CERTIFICATE") || !key.includes("PRIVATE KEY")) return undefined;
    return { cert, key, fingerprint: sha256Fingerprint(cert) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function ensureCert(paths: CertPaths): Promise<CertMaterial> {
  const existing = await tryRead(paths.certPath, paths.keyPath);
  if (existing) return existing;

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
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
            { type: 7, ip: "::1" },
          ],
        },
      ],
    },
  );

  await mkdir(dirname(paths.certPath), { recursive: true });
  await mkdir(dirname(paths.keyPath), { recursive: true });
  await writeFile(paths.certPath, generated.cert, { encoding: "utf8", mode: 0o600 });
  await writeFile(paths.keyPath, generated.private, { encoding: "utf8", mode: 0o600 });

  return {
    cert: generated.cert,
    key: generated.private,
    fingerprint: sha256Fingerprint(generated.cert),
  };
}
