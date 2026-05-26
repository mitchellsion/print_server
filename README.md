# print-server

Local HTTPS bridge between a browser and a POS printer — QZTray-style. Browser POSTs raw ESC/POS bytes; the server forwards them to a USB printer. Cross-platform (macOS, Linux, Windows).

- USB strategy: **libusb primary, OS print spooler fallback** (so it works on Windows even without driver replacement).
- Transport: **HTTPS** with a self-signed cert generated on first run.
- API security: **CORS allowlist** (configurable).
- Payload: raw bytes as **base64 / hex / utf8** — the browser composes ESC/POS; the server is a passthrough.
- Embedded **web GUI** for device inspection, configuration, test prints, and live log/event stream (SSE).
- Future devices (Bluetooth, customer display, serial) plug into the same `Transport` interface.

## Quick start (dev)

```sh
pnpm install
pnpm dev
```

The server prints the listening URL and the cert SHA-256 fingerprint. Open `https://127.0.0.1:8443/` in a browser, accept the cert warning, and compare the fingerprint shown in the GUI to the one in the logs.

## Trust the self-signed cert

The server uses a self-signed cert generated on first run, so browsers show a warning. There are three ways to suppress it; all use the same underlying logic.

**1. From the GUI (recommended for end users).** On first visit, the page shows a yellow banner with the cert's SHA-256 / SHA-1 fingerprints and a **Trust certificate** button. Click it — on macOS you get a native admin prompt; on Linux/Windows the install is silent. Restart the browser. Banner disappears. The same banner has a **Trust on another device** disclosure with download links and per-OS import instructions for phones/tablets/other computers.

**2. From the API.** Useful for installers or scripted deployments:

```sh
curl -k https://127.0.0.1:8443/v1/cert           # check status
curl -k -X POST   https://127.0.0.1:8443/v1/cert/trust   # install
curl -k -X DELETE https://127.0.0.1:8443/v1/cert/trust   # remove
```

A `409` response with `error: "declined by user"` means the user cancelled the OS prompt.

**3. From the CLI.**

```sh
pnpm trust-cert            # add to the OS trust store
pnpm trust-cert --remove   # undo
pnpm trust-cert --yes      # skip the local "Proceed? [y/N]" prompt
```

The CLI prints both fingerprints and the current trust state first — compare to what `pnpm dev` logs at startup before confirming.

### Reaching the server from another device

The bridge cannot install trust on a device it doesn't run on — those steps are manual. But two things have to be true first:

1. **The server must bind to a reachable address.** Default is `127.0.0.1` (loopback only). Set `http.host` to `0.0.0.0` (Config tab, `PUT /v1/config`, or `PRINT_SERVER_HOST` env) and restart.
2. **The cert's SAN list must include the address the remote device uses.** On startup, when `http.host` is non-loopback, the cert is regenerated (if needed) to include all non-internal network interface IPs and the system hostname / `*.local`. Extra names can be pinned via `tls.extraHostnames` / `tls.extraIps` in the config file. A `cert.meta.json` sidecar tracks which SANs the existing cert covers so reboots don't churn the cert when the desired set is already covered. **A regeneration invalidates existing trust** — every device (host + remotes) has to re-import the new cert.

To install the cert on a remote device:

- Download from `https://<host>:<port>/v1/cert.pem` (or `/v1/cert.crt` for iOS/Android). The GUI banner exposes both as buttons. Both routes return the same PEM bytes; only the MIME type and filename differ.
- Import per OS:
  - **iOS/iPadOS:** AirDrop/email the `.crt`, install the profile in Settings → General → VPN & Device Management, enable in Settings → General → About → Certificate Trust Settings.
  - **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate, select the `.crt`.
  - **macOS:** double-click the `.pem`, add to login keychain, then in Keychain Access set the cert's SSL trust to **Always Trust**.
  - **Windows:** double-click the `.crt` → Install Certificate → Current User → Trusted Root Certification Authorities.
  - **Linux (Chrome/Chromium):** `certutil -d sql:~/.pki/nssdb -A -t P,, -n print-server -i print-server.pem` (needs `libnss3-tools` / `nss-tools`).
- Reach the server by a name or IP that appears in the cert's SAN list (`GET /v1/cert` shows it). Hitting it by some other address still fails hostname verification even with the cert trusted.

### What the trust action actually does

| OS | Where the cert is installed | Elevation prompt |
|---|---|---|
| macOS | `~/Library/Keychains/login.keychain-db` via `security add-trusted-cert -r trustRoot` | None — user keychain |
| Linux | Chrome/Chromium NSS DB at `~/.pki/nssdb` via `certutil` | None — user-scoped DB. Firefox uses a separate per-profile DB; import manually if needed. Requires `libnss3-tools` / `nss-tools`. |
| Windows | `Cert:\CurrentUser\Root` via PowerShell `Import-Certificate` | None — current-user scope. |

Server startup logs a clear warning when the cert isn't trusted yet, so headless deployments will notice.

## Build a single-executable

```sh
pnpm package
```

Output: `dist/print-server-<platform>-<arch>/`. The folder contains:
- `print-server` (or `print-server.exe`) — patched Node binary with the SEA blob
- `node_modules/usb/` — native libusb bindings (must live next to the binary)
- `web/` — GUI assets

Ship the folder as a zip per platform. On macOS the build script also ad-hoc codesigns the binary so it can run locally without Gatekeeper killing it.

## API

All routes are HTTPS only.

| Method | Path | Body / notes |
|---|---|---|
| GET  | `/health` | `{ ok, version, uptimeMs, certFingerprint }` |
| GET  | `/v1/devices` | List discovered devices |
| GET  | `/v1/devices/:id` | Device + recent jobs |
| POST | `/v1/devices/refresh` | Force re-discovery |
| POST | `/v1/print` | `{ deviceId, data, encoding: 'base64'\|'hex'\|'utf8', timeoutMs? }` |
| GET  | `/v1/jobs/:jobId` | Job status |
| GET  | `/v1/config` | Sanitized config (`__readonly` lists env-overridden keys) |
| PUT  | `/v1/config` | Validated patch; returns `{ requiresRestart }` |
| GET  | `/v1/events` | SSE stream of device, job, log, config events |
| GET  | `/v1/cert` | Cert metadata + SAN list + trust state |
| POST | `/v1/cert/trust` | Install cert into host OS trust store |
| DELETE | `/v1/cert/trust` | Remove cert from host OS trust store |
| GET  | `/v1/cert.pem` | Download cert as PEM (for remote devices) |
| GET  | `/v1/cert.crt` | Same bytes as `.pem` with `.crt` MIME (iOS/Android) |
| GET  | `/` | Web GUI |

### Print example

```sh
PAYLOAD=$(printf '\x1b@Hello\n\n\n\x1dV\x00' | base64)
curl -k -X POST https://127.0.0.1:8443/v1/print \
  -H 'Content-Type: application/json' \
  -d "{\"deviceId\":\"<id>\",\"data\":\"$PAYLOAD\",\"encoding\":\"base64\"}"
```

## Config

JSON file is the source of truth. Edited via `PUT /v1/config` or directly on disk.

Per-OS location (via `env-paths`):
- macOS: `~/Library/Application Support/print-server/config.json`
- Linux: `~/.config/print-server/config.json`
- Windows: `%APPDATA%\print-server\Config\config.json`

TLS cert and key live under the data directory at the same package name.

### Env overrides

A small set of ops-critical knobs can be overridden by env. Env wins over file; GUI marks these fields read-only.

| Env var | Maps to |
|---|---|
| `PRINT_SERVER_PORT` | `http.port` |
| `PRINT_SERVER_HOST` | `http.host` |
| `PRINT_SERVER_LOG_LEVEL` | `log.level` |
| `PRINT_SERVER_CONFIG` | Override the config file path |

## OS gotchas

### Linux — udev rule for libusb access

Without permission to open the USB device, libusb returns `LIBUSB_ERROR_ACCESS` and the spooler fallback is used (which still works if the printer is configured in CUPS). To enable direct libusb access without `sudo`, install a udev rule:

```
# /etc/udev/rules.d/99-print-server.rules
SUBSYSTEM=="usb", ATTRS{idVendor}=="04b8", MODE="0666"
```

Replace `04b8` with your printer's vendor id, then:

```sh
sudo udevadm control --reload-rules && sudo udevadm trigger
```

### macOS

No driver swap or permission setup needed for typical USB ESC/POS printers. The build script ad-hoc signs the SEA binary; for distribution you will need an Apple Developer ID and notarization (out of scope here).

### Windows — why libusb often falls back to the spooler

The kernel print spooler claims any USB device that advertises the printer class. libusb cannot share that claim, so direct USB writes fail. Two paths:

1. **Recommended:** do nothing. The server detects the failure and uses the OS print spooler transport (`usb-spooler`). Works for any printer with a Windows driver installed.
2. **Power users:** use [Zadig](https://zadig.akeo.ie/) to replace the printer's driver with WinUSB. libusb will work; the spooler won't see the device anymore.

The dual-strategy design exists for this case — most users don't need to do anything.

## Architecture (one-paragraph version)

`src/index.ts` boots: load config → ensure TLS cert → build `EventBus` and `DeviceRegistry` → register transports (`UsbLibusbTransport`, `UsbSpoolerTransport`) → build Fastify with CORS + Helmet + routes → listen on HTTPS. The `JobManager` (`src/jobs/queue.ts`) serializes prints per-device. The web GUI under `src/web/` is plain HTML + vanilla JS and subscribes to `/v1/events` (SSE) for live updates. Add a new transport (Bluetooth, Serial, customer display) by implementing the `Transport` interface in `src/transport/types.ts` and registering it in `src/transport/index.ts` — nothing else needs to change.
