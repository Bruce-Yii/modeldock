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
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
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
  set("trace-detail-title", `${item.kind || "request"} · ${item.id || "unknown"}`);
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
    cell.textContent = "No requests yet.";
    row.append(cell);
    body.append(row);
    return;
  }

  for (const item of items.slice(0, 10)) {
    const row = document.createElement("tr");
    row.className = "trace-row";
    row.tabIndex = 0;
    row.title = "Open sanitized request evidence";
    row.addEventListener("click", () => showTrace(item));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") showTrace(item);
    });
    const target = item.model || item.requestedModel || item.operation || "—";
    const detail =
      item.error ||
      item.query ||
      (item.harnessToolRounds
        ? `${item.harnessToolRounds} internal tool round${item.harnessToolRounds === 1 ? "" : "s"}`
        : item.filteredTools
          ? `${item.filteredTools} special tools replaced`
          : item.imageRefs?.length
            ? `${item.imageRefs.length} image ref`
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

function render(data) {
  const ready = data.ready;
  const status = $("live-status");
  status.className = `status-pill ${ready ? "ready" : "error"}`;
  status.querySelector("strong").textContent = ready ? "Gate ready" : "Token missing";
  renderModelOptions(data);
  set("uptime", `Uptime ${uptime(data.uptimeMs)}`);
  set("main-model", data.config.mainModel);

  const responses = data.responses;
  const success = percent(responses.ok, responses.total);
  set("active-requests", `${responses.active} active`);
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

  const filtered = responses.filteredToolSearch + responses.filteredWebSearch;
  set("filtered-total", number(filtered));
  set("filtered-tool", number(responses.filteredToolSearch));
  set("filtered-web", number(responses.filteredWebSearch));
  set("rewritten-choice", number(responses.rewrittenToolChoice));
  set("bytes-total", bytes(responses.bytesIn + responses.bytesOut));
  set("bytes-in", bytes(responses.bytesIn));
  set("bytes-out", bytes(responses.bytesOut));
  set("stream-count", number(responses.streaming));

  set("cfg-bind", data.config.bind);
  set("cfg-go", data.config.goBaseUrl);
  set("cfg-main", data.config.mainModel);
  set("cfg-vision", data.config.visionModel);
  set("cfg-fallback", data.config.visionFallbackModel);
  set("cfg-exa", data.config.exaMcpUrl);
  renderAutostart(data);
  renderUpdate(data);
  maybePromptSettings(data.config);
  renderRecent(data.recent || []);
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
    ? (autostartEnabled ? "Start at login: on" : "Start at login: off")
    : "Autostart is not supported on this platform";
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
    button.textContent = `Update v${update.latestVersion}`;
    button.title = `New version available (current v${update.currentVersion}). One click to update and restart.`;
  } else {
    button.hidden = true;
  }
}

async function applyUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  const button = $("update-button");
  button.disabled = true;
  button.textContent = "Updating...";
  try {
    const response = await fetch("/api/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Update ${response.status}`);
    button.textContent = "Restarting...";
    awaitRestartThenReload();
  } catch (error) {
    updateBusy = false;
    button.disabled = false;
    button.textContent = "Update";
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
  set("switch-label", data.enabled ? "On" : "Off");
  set(
    "switch-description",
    data.enabled
      ? "Codex is configured to use other APIs through the local ModelDock bridge."
      : "Codex is using its own configuration. Enabling backs it up and selects the local ModelDock provider.",
  );
  const message = $("switch-message");
  message.className = "";
  if (data.stateError) {
    message.textContent = `State error: ${data.stateError}`;
    message.className = "error";
  } else if (data.externallyRestored) {
    message.textContent = "Codex config is already restored; ModelDock state will reconcile on the next action.";
  } else {
    message.textContent = data.enabled ? "Backup ready · provider active" : "Default remains off";
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
  set("switch-message", "Updating Codex config…");
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
events.onopen = () => set("event-connection", "SSE connected");
events.onmessage = (event) => render(JSON.parse(event.data));
events.onerror = () => {
  set("event-connection", "SSE reconnecting");
  poll().catch(() => {});
};

poll().catch(() => set("event-connection", "Status unavailable"));
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
    ? "Enable other APIs for Codex? ModelDock will back up the current user config, replace the active model/provider settings, and require a full Codex restart."
    : "Disable other APIs and restore the backed-up Codex config? A full Codex restart will be required.";
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

let settingsPrompted = false;

function maybePromptSettings(config) {
  if (settingsPrompted) return;
  settingsPrompted = true;
  if (config && !config.tokenConfigured) {
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
    goInput.placeholder = go?.tokenConfigured ? "configured - leave blank to keep" : "sk-... (required)";
    dsInput.placeholder = ds?.tokenConfigured ? "configured - leave blank to keep" : "sk-... (optional)";
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
  status.textContent = "Saving...";
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
    status.textContent = "Saved - active now";
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
