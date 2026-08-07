// Capture assets/dashboard.png for the README.
//
//   npm run shot                       # the running gateway on 4097
//   npm run shot -- http://127.0.0.1:4991 other.png
//
// Chrome's own --screenshot fires at the load event, which is far too early here: the
// dashboard is an empty shell until its first /api/status fetch lands, so that route
// produces a picture of "Connecting", zeroed counters and dashes. --virtual-time-budget
// does not help either - the page holds an SSE connection open, so the virtual clock
// never drains and Chrome hangs. Drive it over CDP instead and capture only once the
// page reports real content.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

const TARGET_URL = process.argv[2] || "http://127.0.0.1:4097";
const OUT = path.resolve(process.argv[3] || "assets/dashboard.png");
const PORT = 9333;
const WIDTH = 1500;
const SCALE = 1.5; // 2x doubles the file size for a README hero without looking better.

const chromePath = (CHROME_CANDIDATES[process.platform] || []).find(existsSync);
if (!chromePath) {
  console.error(`No Chrome found for ${process.platform}. Install Chrome or pass one on PATH.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fail loudly rather than writing a screenshot of an error page.
const probe = await fetch(TARGET_URL, { redirect: "manual" }).catch(() => null);
if (!probe?.ok) {
  console.error(`${TARGET_URL} is not serving (start the gateway first).`);
  process.exit(1);
}

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  `--window-size=${WIDTH},1400`,
  `--user-data-dir=${path.join(os.tmpdir(), "modeldock-shot-profile")}`,
  "about:blank",
], { stdio: "ignore" });

let ws;
try {
  await sleep(2500);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("Chrome exposed no page target");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("CDP connection failed")));
  });

  let messageId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++messageId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: TARGET_URL });

  // "Rendered" means the status pill left Connecting, the runtime map has a bind
  // address, and the speech tile finished probing - i.e. real data, not the shell.
  let rendered = false;
  for (let attempt = 0; attempt < 30 && !rendered; attempt += 1) {
    await sleep(500);
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => {
        const status = document.querySelector('#live-status strong')?.textContent || '';
        const bind = document.getElementById('cfg-bind')?.textContent || '';
        const tts = document.getElementById('speech-tts-status')?.textContent || '';
        return status !== 'Connecting' && bind.includes(':') && !tts.includes('checking');
      })()`,
      returnByValue: true,
    });
    rendered = result?.value === true;
  }
  if (!rendered) console.warn("WARNING: capturing before the dashboard settled; the image may show placeholders.");

  await sleep(1200); // let fonts and the waveform settle
  const { result: metrics } = await send("Runtime.evaluate", {
    expression: "JSON.stringify({ h: document.documentElement.scrollHeight })",
    returnByValue: true,
  });
  const { h } = JSON.parse(metrics.value);
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: h, deviceScaleFactor: SCALE, mobile: false });
  await sleep(600);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const png = Buffer.from(shot.data, "base64");
  writeFileSync(OUT, png);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} - ${WIDTH}x${h} @${SCALE}x, ${(png.length / 1024).toFixed(0)} KB`);
} finally {
  ws?.close();
  chrome.kill();
}
process.exit(0);
