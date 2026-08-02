import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function removeManagedProvider(lines) {
  const output = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[model_providers\.modeldock_go\]\s*(?:#.*)?$/i.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false;
    if (!skipping) output.push(line);
  }
  return output;
}

function topLevelLine(source, key) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const matcher = new RegExp(`^\\s*${key}\\s*=`);
  return lines.slice(0, limit).find((line) => matcher.test(line)) || null;
}

function topLevelString(source, key) {
  const line = topLevelLine(source, key);
  if (!line) return null;
  const match = line.match(/=\s*(["'])(.*?)\1/);
  return match ? match[2] : null;
}

function providerSection(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^\s*\[model_providers\.modeldock_go\]\s*(?:#.*)?$/i.test(line));
  if (start < 0) return [];
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  return lines.slice(start, end);
}

function managedSignature(source) {
  const entries = providerSection(source)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .sort();
  return JSON.stringify({
    model: topLevelString(source, "model"),
    modelProvider: topLevelString(source, "model_provider"),
    webSearch: topLevelString(source, "web_search"),
    provider: entries,
  });
}

function hasManagedRoute(source) {
  return topLevelString(source, "model_provider") === "modeldock_go" || providerSection(source).length > 0;
}

function restoreTopLevel(lines, key, originalLine) {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const matcher = new RegExp(`^\\s*${key}\\s*=`);
  for (let index = limit - 1; index >= 0; index -= 1) if (matcher.test(lines[index])) lines.splice(index, 1);
  if (originalLine) {
    const insertAt = lines.findIndex((line) => /^\s*\[/.test(line));
    lines.splice(insertAt < 0 ? lines.length : insertAt, 0, originalLine);
  }
}

export function mergeRestoredCodexConfig(current, original) {
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const originalSection = providerSection(original);
  const lines = removeManagedProvider(current.replace(/\r\n/g, "\n").split("\n"));
  for (const key of ["model", "model_provider", "web_search"]) restoreTopLevel(lines, key, topLevelLine(original, key));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (originalSection.length) lines.push("", ...originalSection);
  return `${lines.join("\n").replace(/\n/g, newline)}${newline}`;
}

function setTopLevel(lines, key, value) {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const matcher = new RegExp(`^\\s*${key}\\s*=`);
  const matches = [];
  for (let index = 0; index < limit; index += 1) if (matcher.test(lines[index])) matches.push(index);
  if (matches.length) {
    lines[matches[0]] = `${key} = ${tomlString(value)}`;
    for (const index of matches.slice(1).reverse()) lines.splice(index, 1);
    return lines;
  }
  lines.splice(limit, 0, `${key} = ${tomlString(value)}`);
  return lines;
}

export function buildManagedCodexConfig(source, { baseUrl, model }) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let lines = removeManagedProvider(source.replace(/\r\n/g, "\n").split("\n"));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  lines = setTopLevel(lines, "model", model);
  lines = setTopLevel(lines, "model_provider", "modeldock_go");
  lines = setTopLevel(lines, "web_search", "disabled");
  lines.push(
    "",
    "# Managed by ModelDock OpenCode Go Gate. Use the dashboard to restore the backup.",
    "[model_providers.modeldock_go]",
    'name = "ModelDock OpenCode Go gate"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    "# Local-only placeholder; ModelDock replaces it with OPENCODE_GO_TOKEN upstream.",
    'experimental_bearer_token = "local-modeldock"',
  );
  return `${lines.join("\n").replace(/\n/g, newline)}${newline}`;
}

export class CodexConfigSwitcher {
  constructor({ codexHome, baseUrl, model }) {
    this.codexHome = path.resolve(codexHome || path.join(process.cwd(), ".modeldock-codex-home"));
    this.configPath = path.join(this.codexHome, "config.toml");
    this.stateDir = path.join(this.codexHome, "modeldock");
    this.statePath = path.join(this.stateDir, "config-switch-state.json");
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async #readState() {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { enabled: false, restartRequired: false };
      return { enabled: false, restartRequired: false, stateError: error.message };
    }
  }

  async #writeState(state) {
    await mkdir(this.stateDir, { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await copyFile(temporary, this.statePath);
    await unlink(temporary);
  }

  async status() {
    const state = await this.#readState();
    let currentHash = null;
    let configExists = true;
    try {
      currentHash = sha256(await readFile(this.configPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") configExists = false;
      else throw error;
    }
    let current = "";
    if (configExists) current = await readFile(this.configPath, "utf8");
    const routeActive = hasManagedRoute(current);
    const drifted = Boolean(state.enabled && routeActive && state.managedHash && currentHash !== state.managedHash);
    return {
      enabled: Boolean(state.enabled && routeActive),
      managed: Boolean(state.enabled && routeActive && !drifted),
      drifted,
      externallyRestored: Boolean(state.enabled && !routeActive),
      restartRequired: Boolean(state.restartRequired),
      configExists,
      configPath: this.configPath,
      backupPath: state.backupPath || state.lastBackupPath || null,
      changedAt: state.changedAt || null,
      targetModel: this.model,
      targetProvider: "modeldock_go",
      stateError: state.stateError || null,
    };
  }

  async enable() {
    const state = await this.#readState();
    if (state.stateError) throw Object.assign(new Error(`Cannot read switch state: ${state.stateError}`), { code: "STATE_INVALID" });
    if (state.enabled) {
      const status = await this.status();
      if (status.enabled) return status;
      await this.disable();
      return this.enable();
    }

    let original = "";
    let originalExisted = true;
    try {
      original = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      originalExisted = false;
    }
    const backupPath = path.join(this.codexHome, `config.toml.modeldock-backup-${timestamp()}-${randomUUID().slice(0, 8)}`);
    if (originalExisted) await copyFile(this.configPath, backupPath);
    else await writeFile(backupPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });

    const managed = buildManagedCodexConfig(original, { baseUrl: this.baseUrl, model: this.model });
    try {
      await writeFile(this.configPath, managed, { encoding: "utf8", mode: 0o600 });
      await this.#writeState({
        version: 1,
        enabled: true,
        restartRequired: true,
        backupPath,
        originalExisted,
        originalHash: sha256(original),
        managedHash: sha256(managed),
        changedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (originalExisted) await writeFile(this.configPath, original, { encoding: "utf8", mode: 0o600 });
      else await unlink(this.configPath).catch(() => {});
      throw error;
    }
    return this.status();
  }

  async disable() {
    const state = await this.#readState();
    if (!state.enabled) return this.status();
    let current = "";
    try {
      current = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const routeActive = hasManagedRoute(current);
    let backup = "";
    if (routeActive) {
      try {
        backup = await readFile(state.backupPath, "utf8");
      } catch (error) {
        throw Object.assign(new Error("ModelDock backup is missing while its provider is still active; restore requires manual review."), {
          code: "STATE_INVALID",
          cause: error,
        });
      }
      const expected = buildManagedCodexConfig(backup, { baseUrl: this.baseUrl, model: this.model });
      if (sha256(current) !== state.managedHash && managedSignature(current) !== managedSignature(expected)) {
        throw Object.assign(new Error("ModelDock-managed provider fields changed outside ModelDock; refusing an ambiguous restore."), {
          code: "CONFIG_DRIFTED",
        });
      }
    }
    try {
      if (routeActive && state.originalExisted) {
        const restored = sha256(current) === state.managedHash ? backup : mergeRestoredCodexConfig(current, backup);
        await writeFile(this.configPath, restored, { encoding: "utf8", mode: 0o600 });
      } else if (routeActive) await unlink(this.configPath);
      await this.#writeState({
        version: 1,
        enabled: false,
        restartRequired: routeActive ? true : Boolean(state.restartRequired),
        lastBackupPath: state.backupPath,
        changedAt: new Date().toISOString(),
      });
    } catch (error) {
      await writeFile(this.configPath, current, { encoding: "utf8", mode: 0o600 });
      throw error;
    }
    return this.status();
  }

  async acknowledgeRestart() {
    const state = await this.#readState();
    if (state.stateError) throw new Error(`Cannot read switch state: ${state.stateError}`);
    await this.#writeState({ ...state, restartRequired: false });
    return this.status();
  }
}
