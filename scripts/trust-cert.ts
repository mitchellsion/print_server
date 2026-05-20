import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { APP_PATHS } from "../src/config/paths.js";
import { ensureCert } from "../src/tls/cert.js";
import {
  installCertTrust,
  uninstallCertTrust,
  isCertTrusted,
  sha1OfCert,
  formatFingerprint,
} from "../src/tls/trust.js";

interface Args {
  remove: boolean;
  yes: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    remove: argv.includes("--remove") || argv.includes("--untrust"),
    yes: argv.includes("--yes") || argv.includes("-y"),
  };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(question);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!existsSync(APP_PATHS.certFile) && args.remove) {
    console.error(`No cert exists at ${APP_PATHS.certFile}. Nothing to remove.`);
    process.exit(1);
  }

  console.log(`Cert file: ${APP_PATHS.certFile}`);
  if (!existsSync(APP_PATHS.certFile)) {
    console.log("Cert does not exist yet — generating one...");
  }

  const cert = await ensureCert({
    certPath: APP_PATHS.certFile,
    keyPath: APP_PATHS.keyFile,
  });
  const sha1 = sha1OfCert(cert.cert);

  console.log(`SHA-256: ${cert.fingerprint}`);
  console.log(`SHA-1:   ${formatFingerprint(sha1)}`);

  const alreadyTrusted = await isCertTrusted(APP_PATHS.certFile, sha1);
  console.log(`Current status: ${alreadyTrusted ? "TRUSTED" : "not trusted"}`);
  console.log();

  if (!args.remove && alreadyTrusted) {
    console.log("Already trusted. Nothing to do.");
    return;
  }
  if (args.remove && !alreadyTrusted) {
    console.log("Not currently trusted. Nothing to do.");
    return;
  }

  const action = args.remove ? "REMOVE TRUST for" : "TRUST";
  console.log(`This will ${action} the certificate above.`);
  if (!args.yes) {
    const ok = await confirm("Proceed? [y/N] ");
    if (!ok) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  try {
    if (args.remove) {
      await uninstallCertTrust(APP_PATHS.certFile, sha1);
    } else {
      await installCertTrust(APP_PATHS.certFile, sha1);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "declined by user") {
      console.log("\nCancelled by user.");
      process.exit(1);
    }
    console.error(`\nFailed: ${msg}`);
    process.exit(1);
  }

  console.log(
    args.remove
      ? "\nDone. Restart your browser."
      : "\nDone. Restart your browser to pick up the new trust.",
  );
}

main().catch((err) => {
  console.error("\nFailed:", (err as Error).message);
  process.exit(1);
});
