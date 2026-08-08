import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ownerFilePath } from "../src/instance-owner.mjs";

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
  // POSIX: lsof is present on both Linux and macOS runners; fall back to ss (Linux
  // only - macOS has no iproute2, hence the stderr redirect so a missing tool is quiet).
  for (const probe of [`lsof -ti tcp:${port} 2>/dev/null`, `ss -tlnp 2>/dev/null`]) {
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

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Minimal ZIP writer (stored entries) so the Windows Node-download test can serve a
// small fake node archive without depending on external tooling. Read by
// PowerShell's Expand-Archive.
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data);
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(0, 8); // method: stored
    lfh.writeUInt16LE(0, 10); // mtime
    lfh.writeUInt16LE(0, 12); // mdate
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28); // extra
    parts.push(lfh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(0, 10); // method
    ch.writeUInt16LE(0, 12); // mtime
    ch.writeUInt16LE(0, 14); // mdate
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lfh.length + name.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, eocd]);
}

// Minimal USTAR tar writer (for the POSIX Node-download test). Extracted by tar(1).
function buildTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    if (name.length > 100) throw new Error("tar name too long");
    const data = e.type === "dir" ? Buffer.alloc(0) : Buffer.from(e.data);
    const h = Buffer.alloc(512);
    name.copy(h, 0);
    h.write("0000755\0", 100); // mode
    h.write("0000000\0", 108); // uid
    h.write("0000000\0", 116); // gid
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); // size
    h.write("00000000000\0", 136); // mtime
    h.write("        ", 148); // checksum placeholder
    h.write(e.type === "dir" ? "5" : "0", 156); // typeflag
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    h.write("root", 265, 32, "ascii");
    h.write("root", 297, 32, "ascii");
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h);
    if (data.length) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks end the archive
  return Buffer.concat(blocks);
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
  // Use the port the kernel just confirmed free, not that port + 1: +1 was never
  // verified and collides with whatever else holds it (macOS hands out ephemeral
  // ports randomly, so a neighbour being taken is common there).
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  // Cleanup order matters: stop the background gateway first (it holds the install
  // dir open), then remove the dir.
  t.after(() => killByPort(appPort));
  t.after(() => rmSync(installDir, { recursive: true, force: true }));
  // MODELDOCK_STATE_DIR (below) keeps the owner record inside installDir, but the
  // gateway is stopped with a hard kill, so nothing here can rely on its shutdown
  // hook running. Sweep the real home path too: if the redirect ever regresses,
  // this test cleans up after itself instead of leaking a file per run.
  t.after(() => rmSync(ownerFilePath(appPort, os.homedir()), { force: true }));

  // 3. Run the real installer with every default redirected through env vars.
  const installer = path.join(repoRoot, "scripts", installerScript);
  const env = {
    ...process.env,
    MODELDOCK_ROOT: installDir,
    MODELDOCK_RELEASE_URL: releaseUrl,
    MODELDOCK_PORT: String(appPort),
    MODELDOCK_SKIP_OPEN: "1",
    // The installer starts a real gateway, which records port ownership on
    // startup. Point that record at the throwaway root so removing installDir
    // removes it too - the promise above ("never touches the real ~/.modeldock")
    // was untrue while the owner file resolved against the home directory.
    MODELDOCK_STATE_DIR: path.join(installDir, ".modeldock"),
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
  assert.ok(existsSync(path.join(installDir, "scripts", "restart.ps1")), "scripts/restart.ps1 should be written");
  assert.ok(
    existsSync(path.join(installDir, "scripts", isWindows ? "recover.ps1" : "recover.sh")),
    "manual recovery script should be written",
  );
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
  // The launcher runs node in the background, so a startup crash only shows up in the
  // log it writes; surface it here or the failure is just "did not come up".
  if (!healthz) {
    // Windows writes stdout and stderr separately (Start-Process cannot send both to
    // one file); POSIX appends both to modeldock.log.
    const logs = ["modeldock.log", "modeldock.err.log"]
      .map((name) => {
        const file = path.join(installDir, name);
        return `--- ${name} ---\n${existsSync(file) ? readFileSync(file, "utf8") || "(empty)" : "(not written)"}`;
      })
      .join("\n");
    assert.fail(`gateway should come up after install\n--- installer stdout ---\n${out}\n--- installer stderr ---\n${err}\n${logs}`);
  }
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

  // 6. The gateway is up, so it has written its owner record. Assert it landed in
  //    the throwaway root and not in the user's home: this test is stopped with a
  //    hard kill, which skips the shutdown hook that would normally remove it, so
  //    a record written to the real ~/.modeldock would survive every single run.
  assert.ok(existsSync(ownerFilePath(appPort, installDir)), "owner record should follow MODELDOCK_STATE_DIR");
  assert.ok(
    !existsSync(ownerFilePath(appPort, os.homedir())),
    "the real ~/.modeldock must stay untouched",
  );

  // The model catalog follows the same redirect: a gateway started from a
  // throwaway install bakes paths from that install root, so writing it to the
  // real ~/.modeldock would leave the user's catalog pointing at a deleted temp
  // dir. Assert the catalog stayed inside the throwaway root and references the
  // install's own restart script.
  const installedCatalog = path.join(installDir, ".modeldock", "codex-model-catalog.json");
  assert.ok(existsSync(installedCatalog), "catalog should follow MODELDOCK_STATE_DIR");
  const installedCatalogPayload = JSON.parse(readFileSync(installedCatalog, "utf8"));
  // The baked restart path is compared through realpath: Windows may render the
  // temp parent as an 8.3 short name (CHENBA~1) while mkdtempSync returned the
  // long form, so a raw string compare would be flaky.
  const marker = `${path.sep}scripts${path.sep}restart.ps1`;
  const baked = (installedCatalogPayload.models || [])
    .map((model) => model?.base_instructions || "")
    .find((instructions) => instructions.includes(marker)) || "";
  const bakedIndex = baked.indexOf(marker);
  assert.ok(bakedIndex > 0, "catalog base_instructions should reference scripts/restart.ps1");
  // The path is quoted inside the instruction ("...\scripts\restart.ps1"); walk
  // back from the marker to that opening quote so dirname sees a real path.
  const bakedRestartPath = baked.slice(baked.lastIndexOf('"', bakedIndex) + 1, bakedIndex + marker.length);
  const bakedRoot = path.dirname(path.dirname(bakedRestartPath));
  // Ancestor directories may render as 8.3 short names (CHENBA~1 for "Chen Bao"),
  // but the mkdtemp install dir's own name is stable, so compare basenames.
  assert.equal(path.basename(bakedRoot), path.basename(installDir), "restart path should point inside the install root");

  // 7. Stop the background gateway so cleanup can remove the temp install dir.
  killByPort(appPort);
  assert.ok(await waitForPortFree(appPort), "background gateway should stop");
});

test("mock install: auto-download a bundled Node 22 LTS when none is suitable", async (t) => {
  const bundle = readFileSync(path.join(repoRoot, "dist", "modeldock.mjs"));
  const nodeVer = "22.4.0";
  const distName = "v" + nodeVer;

  // Fake nodejs.org/dist server. The version index is ordered newest-first with a
  // non-LTS v23 ahead of the v22 LTS entries, so resolution must pick v22.4.0.
  const zipEntry = { name: `node-${distName}-win-x64/node.exe`, data: "fake node.exe for download test\n" };
  const zip = buildZip([zipEntry]);
  const nodeBin = "#!/bin/sh\nexec node \"$@\"\n";
  const tgz = gzipSync(
    buildTar([
      { name: `node-${distName}-linux-x64/`, type: "dir" },
      { name: `node-${distName}-linux-x64/bin/`, type: "dir" },
      { name: `node-${distName}-linux-x64/bin/node`, type: "file", data: nodeBin },
    ]),
  );
  const tgzDarwin = gzipSync(
    buildTar([
      { name: `node-${distName}-darwin-arm64/`, type: "dir" },
      { name: `node-${distName}-darwin-arm64/bin/`, type: "dir" },
      { name: `node-${distName}-darwin-arm64/bin/node`, type: "file", data: nodeBin },
    ]),
  );
  const shasums =
    [
      `${sha256(zip)}  node-${distName}-win-x64.zip`,
      `${sha256(tgz)}  node-${distName}-linux-x64.tar.gz`,
      `${sha256(tgzDarwin)}  node-${distName}-darwin-arm64.tar.gz`,
      `${sha256(Buffer.from("decoy"))}  node-${distName}-darwin-x64.tar.gz`,
    ].join("\n") + "\n";
  const indexJson = JSON.stringify([
    { version: "v23.1.0", lts: false, npm: "11.0.0" },
    { version: "v22.4.0", lts: "Jod", npm: "10.8.0" },
    { version: "v22.3.0", lts: "Jod", npm: "10.8.0" },
  ]);
  const server = createServer((req, res) => {
    const url = req.url;
    if (url === "/modeldock.mjs") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bundle.length });
      res.end(bundle);
    } else if (url === "/index.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(indexJson);
    } else if (url === `/v${nodeVer}/SHASUMS256.txt`) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(shasums);
    } else if (url === `/v${nodeVer}/node-${distName}-win-x64.zip`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(zip);
    } else if (url === `/v${nodeVer}/node-${distName}-linux-x64.tar.gz`) {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(tgz);
    } else if (url === `/v${nodeVer}/node-${distName}-darwin-arm64.tar.gz`) {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(tgzDarwin);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const serverPort = await listen(server);
  t.after(() => server.close());

  const installDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mock-node-"));
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  t.after(() => killByPort(appPort));
  t.after(() => rmSync(installDir, { recursive: true, force: true }));

  const env = {
    ...process.env,
    MODELDOCK_ROOT: installDir,
    MODELDOCK_RELEASE_URL: `http://127.0.0.1:${serverPort}/modeldock.mjs`,
    MODELDOCK_NODE_BASE_URL: `http://127.0.0.1:${serverPort}`,
    MODELDOCK_FORCE_NODE_DOWNLOAD: "1",
    // The Windows fixture node.exe is a text file; executing it would make Windows
    // pop an "Unsupported 16-Bit Application" dialog and hang the test's launcher.
    // Skip the start on Windows so only download/verify/extract/layout is asserted.
    MODELDOCK_SKIP_START: isWindows ? "1" : "0",
    MODELDOCK_PORT: String(appPort),
    MODELDOCK_SKIP_OPEN: "1",
    MODELDOCK_STATE_DIR: path.join(installDir, ".modeldock"),
  };
  const child = runInstaller(path.join(repoRoot, "scripts", installerScript), env);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, `installer failed:\n${out}\n${err}`);

  // The bundled node landed under <root>/node/v22.4.0 with the archive's content.
  const bundledNode = isWindows
    ? path.join(installDir, "node", `v${nodeVer}`, "node.exe")
    : path.join(installDir, "node", `v${nodeVer}`, "bin", "node");
  assert.ok(existsSync(bundledNode), `bundled node should be extracted at ${bundledNode}`);
  assert.equal(
    readFileSync(bundledNode, "utf8"),
    isWindows ? zipEntry.data : nodeBin,
    "extracted node content should match the archive",
  );
  assert.ok(existsSync(path.join(installDir, "dist", "modeldock.mjs")), "release bundle should still be downloaded");

  // The launcher and restart script carry the bundled-first node resolution.
  const launcher = readFileSync(path.join(installDir, "scripts", launcherName), "utf8");
  const restart = readFileSync(path.join(installDir, "scripts", "restart.ps1"), "utf8");
  assert.ok(
    launcher.includes(isWindows ? 'Join-Path $root "node"' : '"$ROOT"/node/v*'),
    "launcher should prefer the bundled node",
  );
  assert.ok(restart.includes('Join-Path $root "node"'), "restart.ps1 should prefer the bundled node");

  // POSIX: the fixture node is a real executable wrapper, so the launcher can start
  // the gateway with the bundled node end to end. Windows cannot run a text file as
  // node.exe, so only the download/extract/layout path is asserted there.
  if (!isWindows) {
    let healthz;
    for (let i = 0; i < 40 && !healthz; i++) {
      try {
        healthz = await fetchText(`http://127.0.0.1:${appPort}/healthz`);
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(
      healthz && [200, 503].includes(healthz.status),
      `gateway should come up via the bundled node\n${out}\n${err}`,
    );
  }

  killByPort(appPort);
  assert.ok(await waitForPortFree(appPort), "background gateway should stop");
});

test("mock install: rejects a Node download whose SHA256 does not match", async (t) => {
  const nodeVer = "22.4.0";
  const distName = "v" + nodeVer;
  const zip = buildZip([{ name: `node-${distName}-win-x64/node.exe`, data: "fake\n" }]);
  const tgz = gzipSync(
    buildTar([
      { name: `node-${distName}-linux-x64/`, type: "dir" },
      { name: `node-${distName}-linux-x64/bin/`, type: "dir" },
      { name: `node-${distName}-linux-x64/bin/node`, type: "file", data: "#!/bin/sh\n" },
    ]),
  );
  const wrong = sha256(Buffer.from("not the archive"));
  const shasums = [
    `${wrong}  node-${distName}-win-x64.zip`,
    `${wrong}  node-${distName}-linux-x64.tar.gz`,
    `${wrong}  node-${distName}-darwin-arm64.tar.gz`,
  ].join("\n") + "\n";
  const indexJson = JSON.stringify([{ version: "v22.4.0", lts: "Jod", npm: "10.8.0" }]);
  const server = createServer((req, res) => {
    const url = req.url;
    if (url === "/modeldock.mjs") {
      const bundle = readFileSync(path.join(repoRoot, "dist", "modeldock.mjs"));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bundle.length });
      res.end(bundle);
    } else if (url === "/index.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(indexJson);
    } else if (url.endsWith("/SHASUMS256.txt")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(shasums);
    } else if (url.endsWith(".zip")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(zip);
    } else if (url.endsWith(".tar.gz")) {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(tgz);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const serverPort = await listen(server);
  t.after(() => server.close());

  const installDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mock-badsha-"));
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  t.after(() => killByPort(appPort));
  t.after(() => rmSync(installDir, { recursive: true, force: true }));

  const env = {
    ...process.env,
    MODELDOCK_ROOT: installDir,
    MODELDOCK_RELEASE_URL: `http://127.0.0.1:${serverPort}/modeldock.mjs`,
    MODELDOCK_NODE_BASE_URL: `http://127.0.0.1:${serverPort}`,
    MODELDOCK_FORCE_NODE_DOWNLOAD: "1",
    MODELDOCK_PORT: String(appPort),
    MODELDOCK_SKIP_OPEN: "1",
    MODELDOCK_STATE_DIR: path.join(installDir, ".modeldock"),
  };
  const child = runInstaller(path.join(repoRoot, "scripts", installerScript), env);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(exitCode, 0, `a bad SHA256 should fail the install, got exit 0\n${out}\n${err}`);
  assert.match(out + err, /SHA256 mismatch/, `installer should report the hash mismatch\n${out}\n${err}`);
  assert.ok(
    !existsSync(path.join(installDir, "node", `v${nodeVer}`)),
    "no bundled node should be installed after a bad hash",
  );
});
