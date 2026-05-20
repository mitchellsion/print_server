import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { Logger } from "pino";
import { spoolerId } from "./ids.js";
import type {
  DeviceDescriptor,
  DeviceHandle,
  Transport,
} from "./types.js";

interface SpoolerTransportOptions {
  logger: Logger;
}

interface PrinterEntry {
  id: string;
  name: string;
  driver?: string | undefined;
  status?: string | undefined;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: readonly string[],
  options: { input?: Buffer; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${cmd} timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function listPrintersWindows(logger: Logger): Promise<PrinterEntry[]> {
  const script =
    "Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus | ConvertTo-Json -Compress";
  try {
    const res = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeoutMs: 5000 },
    );
    if (res.code !== 0) {
      logger.debug({ stderr: res.stderr }, "Get-Printer failed");
      return [];
    }
    const trimmed = res.stdout.trim();
    if (!trimmed) return [];
    const parsed: unknown = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((row) => {
        const name = String(row.Name ?? "");
        const driver = row.DriverName ? String(row.DriverName) : undefined;
        const status = row.PrinterStatus ? String(row.PrinterStatus) : undefined;
        return { id: spoolerId(name, driver), name, driver, status };
      })
      .filter((p) => p.name.length > 0);
  } catch (err) {
    logger.debug({ err: (err as Error).message }, "windows printer enumeration failed");
    return [];
  }
}

async function listPrintersUnix(logger: Logger): Promise<PrinterEntry[]> {
  try {
    const res = await run("lpstat", ["-e"], { timeoutMs: 5000 });
    if (res.code !== 0) {
      logger.debug({ stderr: res.stderr }, "lpstat -e failed");
      return [];
    }
    return res.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((name) => ({ id: spoolerId(name), name }));
  } catch (err) {
    logger.debug({ err: (err as Error).message }, "unix printer enumeration failed");
    return [];
  }
}

async function writeRawWindows(name: string, data: Buffer, logger: Logger): Promise<void> {
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, byte[] buf, int len, out int written);
}
"@
$bytes = [Convert]::FromBase64String($env:PS_RAW_DATA_B64)
$h = [IntPtr]::Zero
if (-not [RawPrint]::OpenPrinter($env:PS_PRINTER_NAME, [ref] $h, [IntPtr]::Zero)) { throw "OpenPrinter failed" }
try {
  $di = New-Object RawPrint+DOCINFO
  $di.pDocName = 'print-server raw'
  $di.pDataType = 'RAW'
  if (-not [RawPrint]::StartDocPrinter($h, 1, $di)) { throw "StartDocPrinter failed" }
  try {
    if (-not [RawPrint]::StartPagePrinter($h)) { throw "StartPagePrinter failed" }
    $written = 0
    if (-not [RawPrint]::WritePrinter($h, $bytes, $bytes.Length, [ref] $written)) { throw "WritePrinter failed" }
    if ($written -ne $bytes.Length) { throw "WritePrinter wrote $written of $($bytes.Length)" }
  } finally {
    [RawPrint]::EndPagePrinter($h) | Out-Null
    [RawPrint]::EndDocPrinter($h)  | Out-Null
  }
} finally {
  [RawPrint]::ClosePrinter($h) | Out-Null
}
`.trim();

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PS_PRINTER_NAME: name,
        PS_RAW_DATA_B64: data.toString("base64"),
      },
    },
  );

  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        logger.warn({ stderr, code }, "windows raw print failed");
        reject(new Error(`PowerShell raw print exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

async function writeRawUnix(name: string, data: Buffer, logger: Logger): Promise<void> {
  const res = await run("lp", ["-d", name, "-o", "raw", "-"], {
    input: data,
    timeoutMs: 30_000,
  });
  if (res.code !== 0) {
    logger.warn({ stderr: res.stderr, code: res.code }, "lp raw print failed");
    throw new Error(`lp exited with code ${res.code}: ${res.stderr.slice(0, 500)}`);
  }
}

export class UsbSpoolerTransport implements Transport {
  readonly kind = "usb-spooler" as const;
  private printers = new Map<string, PrinterEntry>();
  private readonly isWindows = platform() === "win32";

  constructor(private readonly options: SpoolerTransportOptions) {}

  async discover(): Promise<DeviceDescriptor[]> {
    const entries = this.isWindows
      ? await listPrintersWindows(this.options.logger)
      : await listPrintersUnix(this.options.logger);

    this.printers.clear();
    for (const entry of entries) this.printers.set(entry.id, entry);

    return entries.map((e) => ({
      id: e.id,
      kind: "usb-spooler" as const,
      label: e.driver ? `${e.name} (${e.driver})` : e.name,
      spoolerName: e.name,
      capabilities: { rawWrite: true, bidirectional: false },
    }));
  }

  async open(id: string): Promise<DeviceHandle> {
    const entry = this.printers.get(id);
    if (!entry) throw new Error(`Spooler printer not found: ${id}`);

    const { logger, isWindows } = { logger: this.options.logger, isWindows: this.isWindows };
    const name = entry.name;
    const descriptor: DeviceDescriptor = {
      id: entry.id,
      kind: "usb-spooler",
      label: entry.driver ? `${name} (${entry.driver})` : name,
      spoolerName: name,
      capabilities: { rawWrite: true, bidirectional: false },
    };

    return {
      descriptor,
      async write(data) {
        if (isWindows) await writeRawWindows(name, data, logger);
        else await writeRawUnix(name, data, logger);
      },
      async close() {
        // stateless; nothing to release
      },
    };
  }
}
