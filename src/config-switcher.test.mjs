import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { buildManagedCodexConfig, CodexConfigSwitcher } from "./config-switcher.mjs";

const originalConfig = `model = "gpt-5.6-sol"
approval_policy = "on-request"

[features]
multi_agent = true

[mcp_servers.docs]
url = "https://developers.openai.com/mcp"
`;

async function fixture(t) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-config-switch-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  await writeFile(configPath, originalConfig, "utf8");
  return {
    codexHome,
    configPath,
    switcher: new CodexConfigSwitcher({ codexHome, baseUrl: "http://127.0.0.1:4097/v1", model: "deepseek-v4-flash" }),
  };
}

test("managed config replaces only top-level provider defaults", () => {
  const managed = buildManagedCodexConfig(originalConfig, {
    baseUrl: "http://127.0.0.1:4097/v1",
    model: "deepseek-v4-flash",
  });
  assert.match(managed, /^model = "deepseek-v4-flash"/m);
  assert.match(managed, /^model_provider = "modeldock_go"/m);
  assert.match(managed, /^web_search = "disabled"/m);
  assert.match(managed, /\[features\]\nmulti_agent = true/);
  assert.match(managed, /\[mcp_servers\.docs\]/);
  assert.equal((managed.match(/\[model_providers\.modeldock_go\]/g) || []).length, 1);
  assert.match(managed, /\[model_providers\.modeldock_go\]\n# Managed by ModelDock\./);
  assert.equal((managed.match(/# Managed by ModelDock/g) || []).length, 1);
});

test("defaults off, backs up on enable, and restores exact config on disable", async (t) => {
  const { configPath, switcher } = await fixture(t);
  assert.equal((await switcher.status()).enabled, false);

  const enabled = await switcher.enable();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.managed, true);
  assert.equal(enabled.restartRequired, true);
  assert.equal(await readFile(enabled.backupPath, "utf8"), originalConfig);
  assert.match(await readFile(configPath, "utf8"), /model_provider = "modeldock_go"/);

  assert.equal((await switcher.acknowledgeRestart()).restartRequired, false);
  const disabled = await switcher.disable();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.restartRequired, true);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
});

test("preserves unrelated edits made after enable while restoring managed fields", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  await appendFile(configPath, "\n[plugins.user_added]\nenabled = true\n", "utf8");
  const status = await switcher.status();
  assert.equal(status.drifted, true);
  await switcher.disable();
  const restored = await readFile(configPath, "utf8");
  assert.match(restored, /model = "gpt-5.6-sol"/);
  assert.doesNotMatch(restored, /modeldock_go/);
  assert.doesNotMatch(restored, /Managed by ModelDock/);
  assert.match(restored, /\[plugins\.user_added\]\nenabled = true/);
});

test("refuses restore only when ModelDock-managed fields conflict", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  const current = await readFile(configPath, "utf8");
  await writeFile(configPath, current.replace('model_provider = "modeldock_go"', 'model_provider = "somewhere_else"'), "utf8");
  await assert.rejects(() => switcher.disable(), (error) => error.code === "CONFIG_DRIFTED");
});

test("recognizes a config already restored outside ModelDock and clears stale state", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  await writeFile(configPath, originalConfig, "utf8");
  const status = await switcher.status();
  assert.equal(status.enabled, false);
  assert.equal(status.externallyRestored, true);
  await switcher.disable();
  assert.equal((await switcher.status()).externallyRestored, false);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
});

test("restores the absence of config when none existed before enable", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-config-switch-empty-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const switcher = new CodexConfigSwitcher({ codexHome, baseUrl: "http://127.0.0.1:4097/v1", model: "deepseek-v4-flash" });
  await switcher.enable();
  await switcher.disable();
  await assert.rejects(() => access(path.join(codexHome, "config.toml")), (error) => error.code === "ENOENT");
});
