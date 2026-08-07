// Local TTS (msedge-tts): detect, install on demand, and synthesize speech to a file.
// msedge-tts is a pure npm package (no native binary) that calls the Microsoft Edge
// Read Aloud API with the Edge browser user agent. The synthesized file path is
// returned to the model so it can be surfaced in the conversation (same pattern as
// vision_inspect image refs).

const INSTALL_TIMEOUT_MS = 180_000;
const SPEAK_TIMEOUT_MS = 120_000;

let installed = null;
let lastCheckAt = 0;
const CHECK_TTL_MS = 10_000;

async function probeInstalled() {
  const now = Date.now();
  if (installed !== null && now - lastCheckAt < CHECK_TTL_MS) return installed;
  try {
    const mod = await import("msedge-tts");
    installed = typeof mod?.MsEdgeTTS === "function" || typeof mod?.default === "function";
  } catch {
    installed = false;
  }
  lastCheckAt = now;
  return installed;
}

export async function ttsStatus() {
  return { installed: await probeInstalled() };
}

export async function ttsInstall() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const run = promisify(execFile);
  // On Windows, execFile cannot spawn a .cmd directly in every Node build
  // ("spawn EINVAL"); route through cmd.exe /c so the install button works.
  const args = ["install", "msedge-tts", "--no-save", "--no-audit", "--no-fund"];
  const [cmd, cmdArgs] = process.platform === "win32"
    ? ["cmd.exe", ["/c", "npm", ...args]]
    : ["npm", args];
  await run(cmd, cmdArgs, {
    timeout: INSTALL_TIMEOUT_MS,
    windowsHide: true,
    // fileURLToPath, not URL.pathname: on Windows the latter yields "/D:/..." and npm fails.
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  installed = null; // force re-probe
  return probeInstalled();
}

export async function ttsSpeak({ text = "", voice = "zh-CN-XiaoxiaoNeural", output = "tts-output.webm" } = {}) {
  if (!text.trim()) throw new Error("speak requires a text payload");
  const ok = await probeInstalled();
  if (!ok) throw new Error("msedge-tts is not installed; install it first (dashboard Web tile or `npm install msedge-tts`)");
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const TTS = MsEdgeTTS || (await import("msedge-tts")).default;
  const target = path.isAbsolute(output)
    ? output
    : path.join(tmpdir(), output);
  const tts = new TTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
  const { audioStream } = await tts.toStream(text);
  const chunks = [];
  for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
  if (!chunks.length) throw new Error("msedge-tts produced no audio for this text/voice");
  const audio = Buffer.concat(chunks);
  await writeFile(target, audio);
  return { file: target, bytes: audio.length, voice, text: text.slice(0, 200) };
}
