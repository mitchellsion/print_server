"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const LOG_MAX = 2000;
const LEVEL_RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
}

function switchTab(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const msg = body && (body.message || body.error) ? body.message || body.error : res.statusText;
    const err = new Error(`${res.status} ${msg}`);
    err.body = body;
    throw err;
  }
  return body;
}

async function loadDevices() {
  const list = $("#devices-list");
  const status = $("#devices-status");
  setStatus(status, "loading…");
  try {
    const data = await fetchJson("/v1/devices");
    list.innerHTML = "";
    if (!data.devices.length) {
      list.innerHTML = '<p class="status">No devices found.</p>';
      setStatus(status, `${data.devices.length} device(s)`, "ok");
      return;
    }
    for (const d of data.devices) {
      const card = document.createElement("div");
      card.className = "device";
      const vendor = d.vendor || {};
      const vidpid =
        vendor.vid !== undefined && vendor.pid !== undefined
          ? `${vendor.vid.toString(16).padStart(4, "0")}:${vendor.pid.toString(16).padStart(4, "0")}`
          : null;
      card.innerHTML = `
        <h3>${escapeHtml(d.label)}</h3>
        <div><span class="kind">${escapeHtml(d.kind)}</span></div>
        <dl>
          <div><dt>id</dt><dd>${escapeHtml(d.id)}</dd></div>
          ${vidpid ? `<div><dt>vid:pid</dt><dd>${vidpid}</dd></div>` : ""}
          ${vendor.serial ? `<div><dt>serial</dt><dd>${escapeHtml(vendor.serial)}</dd></div>` : ""}
          ${d.spoolerName ? `<div><dt>spool</dt><dd>${escapeHtml(d.spoolerName)}</dd></div>` : ""}
          <div><dt>queue</dt><dd>${d.queueSize}</dd></div>
        </dl>
        <div class="actions">
          <button class="test-print-btn" data-id="${escapeHtml(d.id)}" data-label="${escapeHtml(d.label)}">Test print</button>
        </div>
      `;
      list.appendChild(card);
    }
    list.querySelectorAll(".test-print-btn").forEach((btn) => {
      btn.addEventListener("click", () => openTestPrint(btn.dataset.id, btn.dataset.label));
    });
    setStatus(status, `${data.devices.length} device(s)`, "ok");
  } catch (err) {
    setStatus(status, err.message, "err");
  }
}

function openTestPrint(id, label) {
  $("#test-device-id").value = id;
  $("#test-device-label").textContent = label;
  const panel = $("#test-print-panel");
  panel.hidden = false;
  panel.open = true;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function submitTestPrint(evt) {
  evt.preventDefault();
  const deviceId = $("#test-device-id").value;
  const encoding = $("#test-encoding").value;
  const data = $("#test-data").value;
  const out = $("#test-result");
  out.textContent = "Sending…";
  try {
    const res = await fetchJson("/v1/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, encoding, data }),
    });
    out.textContent = JSON.stringify(res, null, 2);
  } catch (err) {
    out.textContent = `Error: ${err.message}\n${JSON.stringify(err.body, null, 2)}`;
  }
}

function insertEscPosSample() {
  const sample = "\x1b@\x1b!0Hello from print server\n\n\n\x1dV\x00";
  $("#test-encoding").value = "utf8";
  $("#test-data").value = sample;
}

async function loadConfig() {
  try {
    const { config } = await fetchJson("/v1/config");
    $("#cfg-http-host").value = config.http.host;
    $("#cfg-http-port").value = config.http.port;
    $("#cfg-cors-origins").value = config.cors.origins.join("\n");
    $("#cfg-log-level").value = config.log.level;
    $("#cfg-usb-libusb").checked = config.usb.libusbEnabled;
    $("#cfg-usb-spooler").checked = config.usb.spoolerEnabled;
    const readonly = config.__readonly || [];
    for (const path of readonly) {
      const el = pathToInput(path);
      if (el) {
        el.disabled = true;
        el.title = "Set via environment variable — cannot edit here";
      }
    }
  } catch (err) {
    setStatus($("#config-status"), err.message, "err");
  }
}

function pathToInput(path) {
  switch (path) {
    case "http.host": return $("#cfg-http-host");
    case "http.port": return $("#cfg-http-port");
    case "log.level": return $("#cfg-log-level");
    default: return null;
  }
}

async function saveConfigForm(evt) {
  evt.preventDefault();
  const status = $("#config-status");
  setStatus(status, "saving…");
  $("#config-restart-banner").hidden = true;
  const patch = {
    http: {
      host: $("#cfg-http-host").value || "127.0.0.1",
      port: Number($("#cfg-http-port").value || 8443),
    },
    cors: {
      origins: $("#cfg-cors-origins")
        .value.split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    },
    log: { level: $("#cfg-log-level").value },
    usb: {
      libusbEnabled: $("#cfg-usb-libusb").checked,
      spoolerEnabled: $("#cfg-usb-spooler").checked,
    },
  };
  try {
    const res = await fetchJson("/v1/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setStatus(status, "saved", "ok");
    if (res.requiresRestart) $("#config-restart-banner").hidden = false;
  } catch (err) {
    setStatus(status, err.message, "err");
  }
}

let logEventSource = null;
function startLogStream() {
  if (logEventSource) return;
  const status = $("#log-status");
  setStatus(status, "connecting…");
  const es = new EventSource("/v1/events");
  logEventSource = es;
  es.addEventListener("hello", () => setStatus(status, "connected", "ok"));
  es.addEventListener("log", (e) => appendLog(JSON.parse(e.data), "log"));
  for (const name of [
    "device.attached",
    "device.detached",
    "device.refreshed",
    "job.queued",
    "job.started",
    "job.finished",
    "job.error",
    "config.changed",
  ]) {
    es.addEventListener(name, (e) => appendLog({ name, payload: tryParse(e.data) }, "event"));
  }
  es.onerror = () => setStatus(status, "disconnected (retrying)…", "err");
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

function appendLog(entry, kind) {
  if (kind === "log") {
    const min = $("#log-min-level").value;
    if ((LEVEL_RANK[entry.level] ?? 0) < LEVEL_RANK[min]) return;
  }
  if (kind === "event" && !$("#log-show-events").checked) return;

  const line = document.createElement("div");
  line.className = `log-line ${kind}`;
  if (kind === "log") {
    line.classList.add(entry.level);
    const t = new Date(entry.time).toISOString().split("T")[1].replace("Z", "");
    line.textContent = `${t} ${entry.level.padEnd(5)} ${entry.msg}`;
  } else {
    const t = new Date().toISOString().split("T")[1].replace("Z", "");
    line.textContent = `${t} event ${entry.name} ${JSON.stringify(entry.payload)}`;
  }
  const out = $("#log-output");
  out.appendChild(line);
  while (out.children.length > LOG_MAX) out.removeChild(out.firstChild);
  out.scrollTop = out.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

async function loadHealth() {
  try {
    const h = await fetchJson("/health");
    $("#meta-url").textContent = location.origin;
    $("#meta-fingerprint").textContent = `cert ${h.certFingerprint || ""}`;
  } catch {
    // ignore
  }
}

const TRUST_DISMISS_KEY = "print-server.trust-dismissed";

function isLoopbackHost(h) {
  const s = (h || "").trim().toLowerCase();
  return s === "127.0.0.1" || s === "::1" || s === "localhost";
}

async function refreshTrustBanner() {
  const banner = $("#trust-banner");
  try {
    const cert = await fetchJson("/v1/cert");
    $("#trust-sha256").textContent = cert.sha256 || "";
    $("#trust-sha1").textContent = (cert.sha1 || "").match(/.{2}/g)?.join(":") ?? cert.sha1;

    const sans = cert.sans || { dns: [], ip: [] };
    const sansLine = [...sans.dns, ...sans.ip].join(", ");
    $("#trust-sans").textContent = sansLine || "(none)";

    try {
      const { config } = await fetchJson("/v1/config");
      const bindHost = config.http.host;
      const warn = $("#trust-remote-warning");
      if (isLoopbackHost(bindHost)) {
        $("#trust-bind-host").textContent = bindHost;
        warn.hidden = false;
      } else {
        warn.hidden = true;
      }
    } catch {
      // config fetch failure isn't fatal for the banner
    }

    const dismissedFor = sessionStorage.getItem(TRUST_DISMISS_KEY);
    if (cert.trusted || dismissedFor === cert.sha1) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
    }
    return cert;
  } catch {
    banner.hidden = true;
    return null;
  }
}

async function installTrust() {
  const btn = $("#trust-install");
  const status = $("#trust-status");
  btn.disabled = true;
  setStatus(status, "waiting for OS prompt…");
  try {
    const res = await fetchJson("/v1/cert/trust", { method: "POST" });
    if (res.trusted) {
      setStatus(status, "trusted — restart your browser to clear the warning", "ok");
      setTimeout(() => refreshTrustBanner(), 400);
    } else {
      setStatus(status, "install did not take effect", "err");
    }
  } catch (err) {
    if (err.body && err.body.error === "declined by user") {
      setStatus(status, "cancelled", "err");
    } else {
      setStatus(status, err.message, "err");
    }
  } finally {
    btn.disabled = false;
  }
}

function dismissTrustBanner() {
  const sha1 = $("#trust-sha1").textContent.replace(/:/g, "");
  if (sha1) sessionStorage.setItem(TRUST_DISMISS_KEY, sha1);
  $("#trust-banner").hidden = true;
}

document.addEventListener("DOMContentLoaded", () => {
  $$(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#refresh-devices").addEventListener("click", async () => {
    try {
      await fetchJson("/v1/devices/refresh", { method: "POST" });
    } catch (e) {
      // refresh endpoint failure isn't critical for UX, fall through to reload
    }
    loadDevices();
  });
  $("#test-print-form").addEventListener("submit", submitTestPrint);
  $("#test-sample-esc").addEventListener("click", insertEscPosSample);
  $("#config-form").addEventListener("submit", saveConfigForm);
  $("#log-clear").addEventListener("click", () => ($("#log-output").innerHTML = ""));

  $("#trust-install").addEventListener("click", installTrust);
  $("#trust-dismiss").addEventListener("click", dismissTrustBanner);

  loadHealth();
  refreshTrustBanner();
  loadDevices();
  loadConfig();
  startLogStream();
});
