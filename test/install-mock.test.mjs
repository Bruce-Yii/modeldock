import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Windows executes scripts/install.ps1 (via powershell); macOS/Linux execute
// scripts/install.sh (via sh). Each platform gets a real end-to-end mock install.
const isWindows = process.platform === "win32";
const installerScript = isWindows ? "install.ps1" : "install.sh";
const launcherName = isWindows ? "start-hidden.ps1" : "start-hidden.sh";
const runInstaller = (installer, env) =>
  isWindows
    ? spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn("sh", [installer], { env, stdio: ["ignore", "pipe", "pipe"] });

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function fetchText(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, text };
}

// The installer starts the gateway in the background (a hidden node process). Track
// it down by the port it listens on so cleanup can stop it before removing the
// install dir - an open handle would otherwise make rmSync fail with EPERM.
function pidListeningOn(port) {
  if (isWindows) {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
    return null;
  }
  // POSIX: lsof is present on both Linux and macOS runners; fall back to ss.
  for (const probe of [`lsof -ti tcp:${port}`, `ss -tlnp`]) {
    try {
      const out = execFileSync("sh", ["-c", probe], { encoding: "utf8" });
      if (probe.startsWith("lsof")) {
        const pid = out.trim();
        if (/^\d+$/.test(pid)) return Number(pid);
      } else {
        const line = out
          .split(/\r?\n/)
          .find((l) => l.includes(`:${port}`) && l.includes("pid="));
        if (line) {
          const m = line.match(/pid=(\d+)/);
          if (m) return Number(m[1]);
        }
      }
    } catch {
      // Tool missing or nothing matched; try the next probe.
    }
  }
  return null;
}

function killByPort(port) {
  const pid = pidListeningOn(port);
  if (pid === null) return;
  try {
    if (isWindows) {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      execFileSync("kill", [String(pid)], { stdio: "ignore" });
    }
  } catch {
    // The process may already be gone; treat it as cleaned up.
  }
}

async function waitForPortFree(port, tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (pidListeningOn(port) === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

test("mock install: download -> install -> run", async (t) => {
  const bundle = path.join(repoRoot, "dist", "modeldock.mjs");
  assert.ok(existsSync(bundle), "dist/modeldock.mjs must be built before this test");

  // 1. Local HTTP server pretending to be a GitHub Release asset endpoint. It serves
  //    the real built bundle so the download path is exercised end to end.
  const asset = readFileSync(bundle);
  const assetServer = createServer((req, res) => {
    if (req.url === "/modeldock.mjs") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": asset.length,
      });
      res.end(asset);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const assetPort = await listen(assetServer);
  t.after(() => assetServer.close());
  const releaseUrl = `http://127.0.0.1:${assetPort}/modeldock.mjs`;

  // 2. Temp install dir (never touches the real ~/.modeldock) + a free app port.
  const installDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mock-install-"));
  const probe = createServer();
  const appPort = (await listen(probe)) + 1;
  probe.close();
  // Cleanup order matters: stop the background gateway first (it holds the install
  // dir open), then remove the dir.
  t.after(() => killByPort(appPort));
  t.after(() => rmSync(installDir, { recursive: true, force: true }));

  // 3. Run the real installer with every default redirected through env vars.
  const installer = path.join(repoRoot, "scripts", installerScript);
  const env = {
    ...process.env,
    MODELDOCK_ROOT: installDir,
    MODELDOCK_RELEASE_URL: releaseUrl,
    MODELDOCK_PORT: String(appPort),
    MODELDOCK_SKIP_OPEN: "1",
  };
  const child = runInstaller(installer, env);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, `installer failed:\n${out}\n${err}`);

  // 4. Assert the layout the installer creates.
  const installedBundle = path.join(installDir, "dist", "modeldock.mjs");
  const launcher = path.join(installDir, "scripts", launcherName);
  assert.ok(existsSync(installedBundle), "dist/modeldock.mjs should be downloaded");
  assert.ok(existsSync(launcher), `${launcherName} launcher should be written`);
  assert.equal(readFileSync(installedBundle).length, asset.length, "bundle byte-identical");

  // 5. The installer already started the gateway in the background on $port. Hit
  //    /healthz + dashboard + api/status to prove the installed bundle runs.
  let healthz;
  for (let i = 0; i < 40 && !healthz; i++) {
    try {
      healthz = await fetchText(`http://127.0.0.1:${appPort}/healthz`);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert.ok(healthz, "gateway should come up after install");
  // /healthz answers 503 until a token is configured - that still proves it runs.
  assert.ok([200, 503].includes(healthz.status), `unexpected /healthz status ${healthz.status}`);

  const dashboard = await fetchText(`http://127.0.0.1:${appPort}/`);
  assert.equal(dashboard.status, 200, "dashboard should be served");
  assert.match(dashboard.text, /modeldock/i, "dashboard HTML should mention ModelDock");

  const status = await fetchText(`http://127.0.0.1:${appPort}/api/status`);
  assert.equal(status.status, 200);
  const payload = JSON.parse(status.text);
  assert.ok(payload.config?.bind, "api/status should expose config.bind");
  assert.ok("autostart" in payload, "api/status should expose autostart");

  // 6. Stop the background gateway so cleanup can remove the temp install dir.
  killByPort(appPort);
  assert.ok(await waitForPortFree(appPort), "background gateway should stop");
});
