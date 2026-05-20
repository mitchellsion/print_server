import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

const LINUX_NSS_NICKNAME = "print-server-localhost";

export function sha1OfCert(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const der = Buffer.from(body, "base64");
  return createHash("sha1").update(der).digest("hex").toUpperCase();
}

export function formatFingerprint(hexUpper: string): string {
  return (hexUpper.match(/.{2}/g) ?? []).join(":");
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      }),
    );
  });
}

function loginKeychainPath(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set");
  return join(home, "Library", "Keychains", "login.keychain-db");
}

function isUserDeclinedError(stderr: string): boolean {
  return (
    /user denied/i.test(stderr) ||
    /UserCanceled/i.test(stderr) ||
    /-128\b/.test(stderr) ||
    /cancel/i.test(stderr)
  );
}

export async function isCertTrusted(certPath: string, sha1: string): Promise<boolean> {
  const os = platform();
  if (os === "darwin") {
    const res = await run("security", ["verify-cert", "-c", certPath, "-p", "ssl"]);
    return res.code === 0;
  }
  if (os === "linux") {
    const home = process.env.HOME;
    if (!home) return false;
    const nss = join(home, ".pki", "nssdb");
    if (!existsSync(nss)) return false;
    const res = await run("certutil", [
      "-d",
      `sql:${nss}`,
      "-L",
      "-n",
      LINUX_NSS_NICKNAME,
    ]);
    return res.code === 0;
  }
  if (os === "win32") {
    const ps = `if ((Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq '${sha1}' })) { exit 0 } else { exit 1 }`;
    const res = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ]);
    return res.code === 0;
  }
  return false;
}

export interface InstallTrustOptions {
  promptTitle?: string;
}

export async function installCertTrust(
  certPath: string,
  sha1: string,
  _options: InstallTrustOptions = {},
): Promise<void> {
  const os = platform();

  if (os === "darwin") {
    const keychain = loginKeychainPath();
    const res = await run("security", [
      "add-trusted-cert",
      "-r",
      "trustRoot",
      "-k",
      keychain,
      certPath,
    ]);
    if (res.code !== 0) {
      const msg = res.stderr.trim();
      if (isUserDeclinedError(msg)) throw new Error("declined by user");
      throw new Error(`macOS trust install failed: ${msg || `exit ${res.code}`}`);
    }
    return;
  }

  if (os === "linux") {
    const home = process.env.HOME;
    if (!home) throw new Error("HOME is not set");
    const nss = join(home, ".pki", "nssdb");
    if (!existsSync(nss)) {
      throw new Error(
        `Chrome/Chromium NSS DB not found at ${nss}. Open Chrome at least once first.`,
      );
    }
    const which = await run("which", ["certutil"]);
    if (which.code !== 0) {
      throw new Error(
        "`certutil` is not installed. Install via `sudo apt install libnss3-tools` or `sudo dnf install nss-tools`.",
      );
    }
    await run("certutil", [
      "-d",
      `sql:${nss}`,
      "-D",
      "-n",
      LINUX_NSS_NICKNAME,
    ]).catch(() => undefined);
    const res = await run("certutil", [
      "-d",
      `sql:${nss}`,
      "-A",
      "-t",
      "P,,",
      "-n",
      LINUX_NSS_NICKNAME,
      "-i",
      certPath,
    ]);
    if (res.code !== 0) {
      throw new Error(`certutil failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    return;
  }

  if (os === "win32") {
    const escaped = certPath.replace(/'/g, "''");
    const ps = `$ErrorActionPreference='Stop'; Import-Certificate -FilePath '${escaped}' -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null`;
    const res = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ]);
    if (res.code !== 0) {
      throw new Error(
        `PowerShell import failed: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
    return;
  }

  throw new Error(`Unsupported platform: ${os}`);
}

export async function uninstallCertTrust(
  certPath: string,
  sha1: string,
  _options: InstallTrustOptions = {},
): Promise<void> {
  const os = platform();

  if (os === "darwin") {
    const keychain = loginKeychainPath();
    // Remove the trust setting first (it lives in the user trust domain,
    // separate from the keychain item itself).
    await run("security", ["trust-settings-remove", "-p", "ssl", sha1]).catch(
      () => undefined,
    );
    const res = await run("security", [
      "delete-certificate",
      "-Z",
      sha1,
      keychain,
    ]);
    if (res.code !== 0) {
      const msg = res.stderr.trim();
      if (isUserDeclinedError(msg)) throw new Error("declined by user");
      throw new Error(`macOS trust removal failed: ${msg || `exit ${res.code}`}`);
    }
    return;
  }

  if (os === "linux") {
    const home = process.env.HOME;
    if (!home) throw new Error("HOME is not set");
    const nss = join(home, ".pki", "nssdb");
    const res = await run("certutil", [
      "-d",
      `sql:${nss}`,
      "-D",
      "-n",
      LINUX_NSS_NICKNAME,
    ]);
    if (res.code !== 0) {
      throw new Error(`certutil failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    return;
  }

  if (os === "win32") {
    const ps = `$ErrorActionPreference='Stop'; Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${sha1}' } | Remove-Item`;
    const res = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ]);
    if (res.code !== 0) {
      throw new Error(
        `PowerShell remove failed: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
    return;
  }

  throw new Error(`Unsupported platform: ${os}`);
}

export const TRUST_INSTALL_REQUIRES_ELEVATION: Record<string, boolean> = {
  darwin: false,
  linux: false,
  win32: false,
};
