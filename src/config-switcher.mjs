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
    const drifted = Boolean(state.enabled && state.managedHash && currentHash !== state.managedHash);
    return {
      enabled: Boolean(state.enabled),
      managed: Boolean(state.enabled && !drifted),
      drifted,
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
    if (state.enabled) return this.status();

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
    const current = await readFile(this.configPath, "utf8");
    if (sha256(current) !== state.managedHash) {
      throw Object.assign(new Error("Codex config changed after ModelDock enabled it; refusing to overwrite those edits."), {
        code: "CONFIG_DRIFTED",
      });
    }
    const backup = await readFile(state.backupPath, "utf8");
    try {
      if (state.originalExisted) await writeFile(this.configPath, backup, { encoding: "utf8", mode: 0o600 });
      else await unlink(this.configPath);
      await this.#writeState({
        version: 1,
        enabled: false,
        restartRequired: true,
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
