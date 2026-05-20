#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const root = resolve(dirname(__filename), "..");
const buildDir = join(root, "build");
const distDir = join(root, "dist", `print-server-${platform()}-${arch()}`);
const binName = platform() === "win32" ? "print-server.exe" : "print-server";
const binPath = join(distDir, binName);

const require = createRequire(import.meta.url);

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with status ${result.status}`);
  }
}

function clean() {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
}

function bundle() {
  run("npx", [
    "esbuild",
    "src/index.ts",
    "--bundle",
    "--platform=node",
    "--target=node22",
    "--external:usb",
    "--format=cjs",
    "--outfile=build/bundle.cjs",
  ]);
}

function buildSeaBlob() {
  run(process.execPath, [
    "--experimental-sea-config",
    "sea-config.json",
  ]);
  if (!existsSync(join(buildDir, "sea-prep.blob"))) {
    throw new Error("SEA blob was not produced");
  }
}

function stageNodeBinary() {
  cpSync(process.execPath, binPath);
  if (platform() !== "win32") chmodSync(binPath, 0o755);
}

function postjectBlob() {
  if (platform() === "darwin") {
    try {
      execFileSync("codesign", ["--remove-signature", binName], { cwd: distDir, stdio: "ignore" });
    } catch {
      // not previously signed; ignore
    }
  }
  const args = [
    binName,
    "NODE_SEA_BLOB",
    join(buildDir, "sea-prep.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (platform() === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }
  run("npx", ["postject", ...args], { cwd: distDir });
  if (platform() === "darwin") {
    run("codesign", ["--sign", "-", binName], { cwd: distDir });
  }
}

function copyNativeModules() {
  const usbEntry = require.resolve("usb");
  const usbPkgRoot = (() => {
    let dir = dirname(usbEntry);
    while (dir !== "/" && !existsSync(join(dir, "package.json"))) {
      dir = dirname(dir);
    }
    return dir;
  })();
  if (!usbPkgRoot) throw new Error("could not locate usb package root");

  const destUsb = join(distDir, "node_modules", "usb");
  mkdirSync(dirname(destUsb), { recursive: true });
  cpSync(usbPkgRoot, destUsb, { recursive: true, dereference: true });

  const usbPkg = JSON.parse(readFileSync(join(usbPkgRoot, "package.json"), "utf8"));
  const deps = usbPkg.dependencies ?? {};
  for (const depName of Object.keys(deps)) {
    try {
      const depEntry = require.resolve(depName, { paths: [usbPkgRoot] });
      let dir = dirname(depEntry);
      while (dir !== "/" && !existsSync(join(dir, "package.json"))) {
        dir = dirname(dir);
      }
      const dest = join(distDir, "node_modules", depName);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(dir, dest, { recursive: true, dereference: true });
    } catch (err) {
      console.warn(`! skipped optional dep "${depName}": ${err.message}`);
    }
  }
}

function copyWebAssets() {
  cpSync(join(root, "src", "web"), join(distDir, "web"), { recursive: true });
}

function main() {
  console.log(`building SEA bundle for ${platform()}-${arch()}`);
  clean();
  bundle();
  buildSeaBlob();
  stageNodeBinary();
  postjectBlob();
  copyNativeModules();
  copyWebAssets();
  console.log("");
  console.log(`done. Output at: ${distDir}`);
  console.log(`Run: ${binPath}`);
}

try {
  main();
} catch (err) {
  console.error("build failed:", err.message);
  process.exit(1);
}
