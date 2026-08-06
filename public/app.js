import { t, getLang, setLang, initI18n, applyStaticI18n } from "./i18n.js";

const $ = (id) => document.getElementById(id);

function number(value) {
  return new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0);
}

function bytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function duration(value) {
  if (!value) return "0 ms";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
}

function uptime(value) {
  const seconds = Math.floor((value || 0) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours
    ? `${hours}${t("unit.h")} ${minutes}${t("unit.m")}`
    : `${minutes}${t("unit.m")} ${seconds % 60}${t("unit.s")}`;
}

function set(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function percent(ok, total) {
  return total ? Math.round((ok / total) * 100) : 0;
}

function showTrace(item) {
  const detail = $("trace-detail");
  detail.hidden = false;
  set("trace-detail-title", t("traceDetail.titleFormat", { kind: item.kind || "request", id: item.id || "unknown" }));
  $("trace-detail-json").textContent = JSON.stringify(item, null, 2);
  detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderRecent(items) {
  const body = $("recent-body");
  body.replaceChildren();
  if (!items.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty";
    cell.textContent = t("recent.empty");
    row.append(cell);
    body.append(row);
    return;
  }

  for (const item of items.slice(0, 10)) {
    const row = document.createElement("tr");
    row.className = "trace-row";
    row.tabIndex = 0;
    row.title = t("recent.openTitle");
    row.addEventListener("click", () => showTrace(item));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") showTrace(item);
    });
    const target = item.model || item.requestedModel || item.operation || "—";
    const detail =
      item.error ||
      item.query ||
      (item.harnessToolRounds
        ? t("detail.toolRound", { n: item.harnessToolRounds })
        : item.filteredTools
          ? t("detail.filteredTools", { n: item.filteredTools })
          : item.imageRefs?.length
            ? t("detail.imageRef", { n: item.imageRefs.length })
            : "—");
    const values = [item.kind, target, item.status, duration(item.latencyMs), detail];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      if (index === 2) {
        const status = document.createElement("span");
        status.className = `trace-status ${item.status}`;
        status.append(document.createElement("i"), document.createTextNode(item.status));
        cell.append(status);
      } else {
        cell.textContent = String(value ?? "—");
        cell.title = cell.textContent;
      }
      row.append(cell);
    });
    body.append(row);
  }
}

// Context-token waveform: plots per-call input tokens from the responses metric
// records (chronological, sessions interleaved) onto a small canvas. The history
// buffer lives in the browser so the wave persists and grows across SSE updates.
const waveHistory = [];
const WAVE_MAX_POINTS = 180;
let waveHover = -1;
let wavePeak = 0;
let wavePoints = [];

function renderContextWave(recent) {
  const canvas = $("context-wave");
  if (!canvas) return;
  const seen = new Set(waveHistory.map((point) => point.id));
  for (const item of recent) {
    // Only sample completed responses. In-flight (active) records carry no usage
    // yet and would otherwise pin the newest sample at 0; skipping them here means
    // a record is first added when it finishes with a real input-token count.
    if (item.kind !== "responses" || item.status !== "ok" || seen.has(item.id)) continue;
    waveHistory.push({ id: item.id, t: item.startedAt || 0, v: Number(item.inputTokens) || 0 });
  }
  waveHistory.sort((a, b) => a.t - b.t);
  if (waveHistory.length > WAVE_MAX_POINTS) waveHistory.splice(0, waveHistory.length - WAVE_MAX_POINTS);
  const last = waveHistory.length ? waveHistory[waveHistory.length - 1].v : 0;
  const peak = waveHistory.reduce((max, point) => Math.max(max, point.v), 0);
  wavePeak = peak;
  set("wave-last", number(last));
  set("wave-peak", number(peak));
  set("wave-count", number(waveHistory.length));
  drawWave(canvas, waveHistory, peak, waveHover);
}

function drawWave(canvas, history, peak, hoverIndex = -1) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = 4;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const max = peak || 1;
  const n = history.length;
  wavePoints = [];

  // Gridlines (3 horizontal ticks).
  ctx.strokeStyle = "rgba(247,185,85,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    const y = pad + (plotH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  if (n === 0) return;

  // Area fill under the curve.
  const gradient = ctx.createLinearGradient(0, pad, 0, pad + plotH);
  gradient.addColorStop(0, "rgba(247,185,85,0.35)");
  gradient.addColorStop(1, "rgba(247,185,85,0)");
  ctx.beginPath();
  ctx.moveTo(pad, pad + plotH);
  history.forEach((point, index) => {
    const x = pad + (n === 1 ? plotW / 2 : (plotW * index) / (n - 1));
    const y = pad + plotH - Math.min(1, point.v / max) * plotH;
    wavePoints.push({ x, y, v: point.v, t: point.t });
    ctx.lineTo(x, y);
  });
  ctx.lineTo(width - pad, pad + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line with a soft glow.
  ctx.beginPath();
  history.forEach((point, index) => {
    const x = pad + (n === 1 ? plotW / 2 : (plotW * index) / (n - 1));
    const y = pad + plotH - Math.min(1, point.v / max) * plotH;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "rgba(247,185,85,0.9)";
  ctx.lineWidth = 2;
  ctx.shadowColor = "rgba(247,185,85,0.5)";
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Hover guide: vertical rule + highlighted sample.
  if (hoverIndex >= 0 && wavePoints[hoverIndex]) {
    const p = wavePoints[hoverIndex];
    ctx.strokeStyle = "rgba(247,185,85,0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(p.x, pad);
    ctx.lineTo(p.x, pad + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#f7b955";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(8,16,24,.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Peak marker dot.
  if (n > 0 && peak > 0) {
    let peakIndex = 0;
    history.forEach((point, index) => { if (point.v >= history[peakIndex].v) peakIndex = index; });
    const px = pad + (n === 1 ? plotW / 2 : (plotW * peakIndex) / (n - 1));
    const py = pad + plotH - (history[peakIndex].v / max) * plotH;
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#f7b955";
    ctx.fill();
  }
}

function attachWaveHover() {
  const canvas = $("context-wave");
  const tooltip = $("wave-tooltip");
  if (!canvas || !tooltip) return;

  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    let nearest = -1;
    let best = Infinity;
    wavePoints.forEach((point, index) => {
      const distance = Math.abs(point.x - x);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    if (nearest !== waveHover) {
      waveHover = nearest;
      drawWave(canvas, waveHistory, wavePeak, waveHover);
    }
    if (nearest >= 0) {
      const point = wavePoints[nearest];
      const percentX = Math.max(0, Math.min(rect.width, point.x)) / rect.width;
      tooltip.style.left = `${(point.x / rect.width) * 100}%`;
      tooltip.style.transform = `translateX(${percentX < 0.08 ? "0%" : percentX > 0.92 ? "-100%" : "-50%"})`;
      tooltip.innerHTML = `<b>${number(point.v)}</b><small>${formatWaveTime(point.t)}</small>`;
      tooltip.hidden = false;
    } else {
      tooltip.hidden = true;
    }
  });

  canvas.addEventListener("mouseleave", () => {
    waveHover = -1;
    tooltip.hidden = true;
    drawWave(canvas, waveHistory, wavePeak, waveHover);
  });
}

function formatWaveTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

let lastData = null;

function render(data) {
  lastData = data;
  const ready = data.ready;
  const status = $("live-status");
  status.className = `status-pill ${ready ? "ready" : "error"}`;
  status.querySelector("strong").textContent = ready ? t("status.ready") : t("status.tokenMissing");
  renderModelOptions(data);
  set("uptime", `${t("status.uptime")} ${uptime(data.uptimeMs)}`);
  set("main-model", data.config.mainModel);
  if (data.config.mainProviderLabel) set("route-provider", data.config.mainProviderLabel);
  if (data.config.mainWire) set("route-wire", data.config.mainWire === "chat" ? "chat/completions" : "responses");

  const responses = data.responses;
  const success = percent(responses.ok, responses.total);
  set("active-requests", `${responses.active} ${t("metric.active")}`);
  set("requests-total", number(responses.total));
  set("requests-success", `${success}%`);
  set("requests-latency", duration(responses.averageLatencyMs));
  $("requests-success-meter").style.width = `${success}%`;

  const inputTokens = responses.inputTokens || 0;
  const outputTokens = responses.outputTokens || 0;
  const tokens = inputTokens + outputTokens;
  set("tokens-total", number(tokens));
  set("tokens-input", number(inputTokens));
  set("tokens-output", number(outputTokens));
  $("token-meter-input").style.width = `${tokens ? Math.round((inputTokens / tokens) * 100) : 0}%`;

  renderContextWave(data.recent || []);
  set("bytes-total", bytes(responses.bytesIn + responses.bytesOut));
  set("bytes-in", bytes(responses.bytesIn));
  set("bytes-out", bytes(responses.bytesOut));
  set("stream-count", number(responses.streaming));

  set("cfg-bind", data.config.bind);
  const mainUpstream = data.config.mainUpstreamUrl || data.config.goBaseUrl;
  set("cfg-go", mainUpstream);
  const upstreamDd = $("cfg-go");
  if (upstreamDd) upstreamDd.title = mainUpstream;
  set("cfg-main", data.config.mainModel);
  set("cfg-vision", data.config.visionModel);
  const visionDd = $("cfg-vision");
  if (visionDd && data.config.visionUpstreamUrl) visionDd.title = t("runtime.via", { url: data.config.visionUpstreamUrl });
  set("cfg-fallback", data.config.visionFallbackModel);
  set("cfg-exa", data.config.exaMcpUrl);
  renderAutostart(data);
  renderSpeech(data);
  renderUpdate(data);
  maybePromptSettings(data.config);
  renderRecent(data.recent || []);
}

async function renderSpeech(data) {
  const ttsStatus = $("speech-tts-status");
  const sttStatus = $("speech-stt-status");
  const installBtn = $("speech-tts-install");
  if (!ttsStatus || !sttStatus) return;
  const green = "var(--green)";
  const red = "#ff7b7b";
  try {
    const res = await fetch("/api/speech", { headers: { accept: "application/json" } });
    const body = await res.json();
    const tts = body.tts || {};
    const stt = body.stt || {};
    ttsStatus.textContent = tts.installed ? t("speech.ttsOn") : t("speech.ttsOff");
    ttsStatus.style.color = tts.installed ? green : red;
    sttStatus.textContent = stt.available
      ? `${t("speech.sttOn")} · ${stt.cultures.join(" / ")}`
      : t("speech.sttOff");
    sttStatus.style.color = stt.available ? green : red;
    installBtn.hidden = tts.installed;
    installBtn.disabled = false;
  } catch {
    ttsStatus.textContent = t("speech.ttsOff");
    ttsStatus.style.color = red;
    sttStatus.textContent = t("speech.sttOff");
    sttStatus.style.color = red;
  }
}

function renderModelOptions(data) {
  const models = data.models;
  if (!models?.options) return;
  const selected = models.selected || {};
  const providers = models.providers || [];
  const selectedProvider = models.selectedProvider || "other";
  const visionProviders = models.visionProviders || providers;
  const selectedVisionProvider = models.selectedVisionProvider || selectedProvider;
  const providerSelect = $("main-provider-select");
  if (providerSelect && providers.length) {
    providerSelect.replaceChildren();
    for (const provider of providers) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      providerSelect.append(option);
    }
    providerSelect.value = selectedProvider;
    providerSelect.disabled = modelBusy;
  }
  const visionProviderSelect = $("vision-provider-select");
  if (visionProviderSelect && visionProviders.length) {
    visionProviderSelect.replaceChildren();
    for (const provider of visionProviders) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      visionProviderSelect.append(option);
    }
    visionProviderSelect.value = selectedVisionProvider;
    visionProviderSelect.disabled = modelBusy;
  }
  const mainFilter = (model) => model.provider === selectedProvider;
  const visionFilter = (model) => model.supportsVision && model.provider === (visionProviderSelect?.value || selectedVisionProvider);
  for (const [id, filter, value, sortBy] of [["main-model-select", mainFilter, selected.mainModel, null], ["vision-model-select", visionFilter, selected.visionModel, "balanceScore"]]) {
    const select = $(id);
    if (!select) continue;
    const previous = select.value;
    select.replaceChildren();
    const filtered = models.options.filter(filter);
    if (sortBy) filtered.sort((a, b) => (b[sortBy] ?? -1) - (a[sortBy] ?? -1) || a.id.localeCompare(b.id));
    for (const model of filtered) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.tierLabel ? `${model.label} (${model.tierLabel})` : model.label;
      option.dataset.provider = model.provider || "";
      option.dataset.tier = model.visionTier || "";
      select.append(option);
    }
    select.value = filtered.some((model) => model.id === value) ? value : (filtered[0]?.id || previous);
    select.disabled = modelBusy;
  }
}

let autostartBusy = false;
let modelBusy = false;
let autostartEnabled = false;

async function setModels() {
  modelBusy = true;
  $("main-model-select").disabled = true;
  $("main-provider-select").disabled = true;
  $("vision-model-select").disabled = true;
  $("vision-provider-select").disabled = true;
  try {
    const response = await fetch("/api/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mainModel: $("main-model-select").value, visionModel: $("vision-model-select").value, provider: $("main-provider-select").value }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Model update ${response.status}`);
  } catch (error) {
    window.alert(error.message);
  } finally {
    modelBusy = false;
    poll().catch(() => {});
  }
}

function renderAutostart(data) {
  autostartEnabled = Boolean(data.autostart?.enabled);
  const supported = Boolean(data.autostart?.supported);
  const toggle = $("autostart-toggle");
  toggle.checked = autostartEnabled;
  toggle.disabled = autostartBusy || !supported;
  $("autostart-off-label").classList.toggle("active", !autostartEnabled);
  $("autostart-on-label").classList.toggle("active", autostartEnabled);
  toggle.title = supported
    ? (autostartEnabled ? t("autostart.titleOn") : t("autostart.titleOff"))
    : t("autostart.unsupported");
}

async function setAutostartEnabled(enabled) {
  autostartBusy = true;
  $("autostart-toggle").disabled = true;
  try {
    const response = await fetch("/api/autostart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Autostart update ${response.status}`);
    renderAutostart({ autostart: { supported: true, enabled: body.enabled } });
  } catch (error) {
    renderAutostart({ autostart: { supported: true, enabled: autostartEnabled } });
    window.alert(error.message);
  } finally {
    autostartBusy = false;
    $("autostart-toggle").disabled = false;
  }
}

let updateBusy = false;

function renderUpdate(data) {
  const button = $("update-button");
  if (!button || updateBusy) return;
  const update = data.update;
  if (update?.available) {
    button.hidden = false;
    button.textContent = t("update.available", { n: update.latestVersion });
    button.title = t("update.title", { current: update.currentVersion });
  } else {
    button.hidden = true;
  }
}

async function applyUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  const button = $("update-button");
  button.disabled = true;
  button.textContent = t("update.updating");
  try {
    const response = await fetch("/api/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Update ${response.status}`);
    button.textContent = t("update.restarting");
    awaitRestartThenReload();
  } catch (error) {
    updateBusy = false;
    button.disabled = false;
    button.textContent = t("button.update");
    window.alert(error.message);
  }
}

// The old process exits ~1s after responding and the relauncher waits 2s before
// starting the new one, so begin probing after 4s and reload on the first answer.
function awaitRestartThenReload() {
  const started = Date.now();
  setTimeout(function probe() {
    fetch("/api/status", { cache: "no-store" })
      .then((response) => {
        if (response.ok) window.location.reload();
        else throw new Error("not ready");
      })
      .catch(() => {
        if (Date.now() - started > 120_000) window.location.reload();
        else setTimeout(probe, 2_000);
      });
  }, 4_000);
}

let switchBusy = false;
let switchState = null;

function renderConfigSwitch(data) {
  switchState = data;
  const toggle = $("proxy-toggle");
  toggle.checked = Boolean(data.enabled);
  toggle.disabled = switchBusy;
  set("switch-label", data.enabled ? t("switch.on") : t("switch.off"));
  set(
    "switch-description",
    data.enabled
      ? t("switch.descEnabled")
      : t("switch.descDisabled"),
  );
  const message = $("switch-message");
  message.className = "";
  if (data.stateError) {
    message.textContent = t("switch.stateError", { msg: data.stateError });
    message.className = "error";
  } else if (data.externallyRestored) {
    message.textContent = t("switch.restored");
  } else {
    message.textContent = data.enabled ? t("switch.backupReady") : t("switch.defaultOff");
  }
  $("restart-banner").hidden = !data.restartRequired;
}

async function pollConfig() {
  const response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error(`Config status ${response.status}`);
  renderConfigSwitch(await response.json());
}

async function configAction(action) {
  switchBusy = true;
  $("proxy-toggle").disabled = true;
  set("switch-message", t("switch.updating"));
  try {
    const response = await fetch(`/api/config/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Config update ${response.status}`);
    renderConfigSwitch(body);
  } catch (error) {
    const message = $("switch-message");
    message.textContent = error.message;
    message.className = "error";
    if (switchState) $("proxy-toggle").checked = Boolean(switchState.enabled);
  } finally {
    switchBusy = false;
    $("proxy-toggle").disabled = false;
  }
}

async function poll() {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error(`Status ${response.status}`);
  render(await response.json());
}

const events = new EventSource("/api/events");
events.onopen = () => set("event-connection", t("event.connected"));
events.onmessage = (event) => render(JSON.parse(event.data));
events.onerror = () => {
  set("event-connection", t("event.reconnecting"));
  poll().catch(() => {});
  };

attachWaveHover();

poll().catch(() => set("event-connection", t("event.unavailable")));
pollConfig().catch((error) => {
  const message = $("switch-message");
  message.textContent = error.message;
  message.className = "error";
});
setInterval(() => poll().catch(() => {}), 15_000);
setInterval(() => pollConfig().catch(() => {}), 15_000);

$("proxy-toggle").addEventListener("change", async (event) => {
  const enabling = event.target.checked;
  const prompt = enabling
    ? t("confirm.enable")
    : t("confirm.disable");
  if (!window.confirm(prompt)) {
    event.target.checked = !enabling;
    return;
  }
  await configAction(enabling ? "enable" : "disable");
});

$("autostart-toggle").addEventListener("change", (event) => {
  setAutostartEnabled(event.target.checked);
});

$("main-provider-select").addEventListener("change", async (event) => {
  const provider = event.target.value;
  const modelSelect = $("main-model-select");
  const options = Array.from(modelSelect.options).filter((option) => option.dataset.provider === provider);
  if (options.length) modelSelect.value = options[0].value;
  await setModels();
});

$("main-model-select").addEventListener("change", setModels);
$("vision-model-select").addEventListener("change", setModels);
$("vision-provider-select").addEventListener("change", () => {
  const provider = $("vision-provider-select").value;
  const modelSelect = $("vision-model-select");
  const options = Array.from(modelSelect.options).filter((option) => option.dataset.provider === provider);
  if (options.length) modelSelect.value = options[0].value;
});

$("restart-ack").addEventListener("click", () => configAction("restart-ack"));
$("trace-detail-close").addEventListener("click", () => { $("trace-detail").hidden = true; });

const ttsInstallBtn = $("speech-tts-install");
if (ttsInstallBtn) {
  ttsInstallBtn.addEventListener("click", async () => {
    ttsInstallBtn.disabled = true;
    ttsInstallBtn.textContent = t("speech.installing");
    try {
      const res = await fetch("/api/speech/install", { method: "POST", headers: { accept: "application/json" } });
      const body = await res.json();
      if (res.ok && body.installed) {
        $("speech-tts-status").textContent = t("speech.ttsOn");
        $("speech-tts-status").style.color = "var(--green)";
        ttsInstallBtn.hidden = true;
      } else {
        $("speech-tts-status").textContent = `${t("speech.ttsOff")} (${body.error?.message || t("speech.ttsOff")})`;
      }
    } catch {
      $("speech-tts-status").textContent = t("speech.ttsOff");
    }
    ttsInstallBtn.textContent = t("speech.install");
    ttsInstallBtn.disabled = false;
  });
}

let settingsPrompted = false;

function maybePromptSettings(config) {
  if (settingsPrompted) return;
  settingsPrompted = true;
  const openRequested = new URLSearchParams(location.search).get("settings") === "1";
  if (openRequested || (config && !config.tokenConfigured)) {
    openSettings();
  }
}

async function openSettings() {
  const dialog = $("settings-dialog");
  if (!dialog) return;
  try {
    const response = await fetch("/api/settings", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Settings ${response.status}`);
    const go = (data.providers || []).find((p) => p.id === "opencode-go");
    const ds = (data.providers || []).find((p) => p.id === "deepseek-official");
    const goInput = $("settings-go-token");
    const dsInput = $("settings-deepseek-token");
    goInput.value = "";
    dsInput.value = "";
    goInput.placeholder = go?.tokenConfigured ? t("settings.configured") : t("settings.required");
    dsInput.placeholder = ds?.tokenConfigured ? t("settings.configured") : t("settings.optional");
    $("settings-status").textContent = "";
    $("settings-envfile").textContent = data.envFile || "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  } catch (error) {
    window.alert(error.message);
  }
}

function closeSettings() {
  const dialog = $("settings-dialog");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

async function saveSettings() {
  const saveBtn = $("settings-save");
  saveBtn.disabled = true;
  const status = $("settings-status");
  status.textContent = t("settings.saving");
  try {
    const body = {};
    const go = $("settings-go-token").value.trim();
    const ds = $("settings-deepseek-token").value.trim();
    if (go) body.opencodeGoToken = go;
    if (ds) body.deepseekApiKey = ds;
    if (!Object.keys(body).length) {
      closeSettings();
      return;
    }
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Save ${response.status}`);
    status.textContent = t("settings.saved");
    closeSettings();
    poll().catch(() => {});
  } catch (error) {
    status.textContent = error.message;
  } finally {
    saveBtn.disabled = false;
  }
}

$("settings-open")?.addEventListener("click", openSettings);
$("settings-close")?.addEventListener("click", closeSettings);
$("settings-save")?.addEventListener("click", saveSettings);
$("update-button")?.addEventListener("click", applyUpdate);

// Language selector: re-apply static text and refresh dynamic text in place.
function refreshDynamicText() {
  applyStaticI18n();
  if (typeof lastData !== "undefined" && lastData) render(lastData);
  pollConfig().catch(() => {});
}

const langSelect = $("settings-lang");
if (langSelect) {
  langSelect.addEventListener("change", (event) => {
    setLang(event.target.value);
    refreshDynamicText();
  });
}

initI18n();
// After initI18n, not before: it resolves the stored/browser language, so reading it
// earlier would leave the picker on "English" while the page renders in another one.
if (langSelect) langSelect.value = getLang();
