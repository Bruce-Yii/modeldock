// Local STT: transcribe an audio file with the best engine available per platform.
// Windows uses the built-in SAPI dictation engine (System.Speech, ships with
// Windows). macOS/Linux use whisper.cpp's small native `whisper-cli` binary
// (Homebrew's `whisper-cpp`), which is Apple Silicon friendly and does not need a
// large Python/OpenAI stack. ffmpeg is used when present to convert non-WAV input.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);

const CHECK_TTL_MS = 10_000;
const FFMPEG_TTL_MS = 10_000;
const WHISPER_TTL_MS = 10_000;
const WHISPER_RUN_TIMEOUT_MS = 600_000;

let sapiCache = null;
let sapiCheckedAt = 0;
let ffmpegCache = null;
let ffmpegCheckedAt = 0;
let whisperCache = null;
let whisperCheckedAt = 0;

function runCommand(cmd, args, options = {}) {
  return run(cmd, args, {
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

async function probeSapi() {
  if (process.platform !== "win32") return [];
  const now = Date.now();
  if (sapiCache !== null && now - sapiCheckedAt < CHECK_TTL_MS) return sapiCache;
  const script = "Add-Type -AssemblyName System.Speech; [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }";
  try {
    const raw = await runPowerShell(script);
    sapiCache = String(raw || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    sapiCache = [];
  }
  sapiCheckedAt = now;
  return sapiCache;
}

async function probeWhisper() {
  if (process.platform === "win32") return null;
  const now = Date.now();
  if (whisperCache !== null && now - whisperCheckedAt < WHISPER_TTL_MS) return whisperCache;
  const configured = process.env.MODELDOCK_WHISPER_BIN?.trim();
  if (configured) {
    whisperCache = {
      kind: "whisper-cpp",
      bin: configured,
    };
  } else {
    whisperCache = null;
    try {
      await runCommand("which", ["whisper-cli"]);
      whisperCache = { kind: "whisper-cpp", bin: "whisper-cli" };
    } catch {
      whisperCache = null;
    }
  }
  whisperCheckedAt = now;
  return whisperCache;
}

export function whisperLanguageFor(language) {
  if (!language || language === "auto") return "";
  const code = String(language).split(/[-_]/)[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(code) ? code : "";
}

function whisperModelCandidates() {
  const configured = process.env.MODELDOCK_WHISPER_MODEL?.trim();
  if (configured) return [path.resolve(configured)];
  const roots = [
    path.join(homedir(), "Library", "Application Support", "whisper-cpp"),
    path.join(homedir(), ".cache", "whisper"),
    path.join(homedir(), ".whisper", "models"),
    "/opt/homebrew/share/whisper-cpp/models",
    "/usr/local/share/whisper-cpp/models",
  ];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (name.endsWith(".bin")) found.push(path.join(root, name));
    }
  }
  return found;
}

async function findWhisperModel() {
  for (const model of whisperModelCandidates()) {
    if (existsSync(model)) return model;
  }
  return null;
}

async function ensureWhisperModel() {
  const existing = await findWhisperModel();
  if (existing) return existing;
  if (process.env.MODELDOCK_WHISPER_AUTO_MODEL === "0") return null;
  const url = process.env.MODELDOCK_WHISPER_MODEL_URL
    || "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin";
  const target = path.join(homedir(), ".cache", "whisper", "ggml-tiny.bin");
  if (!existsSync(target)) {
    mkdirSync(path.dirname(target), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download whisper model: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, target);
  }
  return target;
}

export async function sttStatus() {
  if (process.platform === "win32") {
    const cultures = await probeSapi();
    return {
      available: cultures.length > 0,
      cultures,
      engine: "sapi",
      ffmpeg: await findFfmpeg(),
      hint: null,
    };
  }
  const engine = await probeWhisper();
  const model = engine?.kind === "whisper-cpp" ? await findWhisperModel() : null;
  const available = Boolean(engine) && Boolean(model);
  let hint = null;
  if (!available) {
    hint = engine
      ? "whisper.cpp is installed. The first hear call downloads the small ggml-tiny model unless MODELDOCK_WHISPER_AUTO_MODEL=0 or MODELDOCK_WHISPER_MODEL is set."
      : "No whisper.cpp engine found. Install it with: brew install whisper-cpp, then set MODELDOCK_WHISPER_MODEL to a ggml-*.bin path.";
  }
  return {
    available,
    cultures: available ? [engine.kind] : [],
    engine: engine?.kind || null,
    model,
    ffmpeg: await findFfmpeg(),
    hint,
  };
}

async function findFfmpeg() {
  const now = Date.now();
  if (ffmpegCache !== null && now - ffmpegCheckedAt < FFMPEG_TTL_MS) return ffmpegCache;
  try {
    await runCommand(process.platform === "win32" ? "where.exe" : "which", ["ffmpeg"]);
    ffmpegCache = true;
  } catch {
    ffmpegCache = false;
  }
  ffmpegCheckedAt = now;
  return ffmpegCache;
}

async function findFfmpegPath() {
  try {
    const { stdout } = await runCommand(process.platform === "win32" ? "where.exe" : "which", ["ffmpeg"]);
    return stdout.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

// Values that come from the model (culture, file paths) are passed as environment
// variables and read inside the script, never interpolated into it: string-built
// PowerShell is a command-injection hole the moment a value contains a quote or $(...).
async function runPowerShell(script, vars = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...vars },
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message} | stderr: ${(stderr || "").slice(0, 200)}`));
      resolve(String(stdout || "").trim());
    });
  });
}

async function transcribeWindows({ file, language = "auto", output = "" }) {
  const cultures = await probeSapi();
  if (!cultures.length) throw new Error("no Windows SAPI recognizer available");
  const requested = String(language || "auto");
  const matched = requested !== "auto"
    ? cultures.find((c) => c.toLowerCase().startsWith(requested.toLowerCase()))
    : null;
  const culture = matched
    || (requested !== "auto" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(requested) ? requested : null)
    || (cultures.includes("zh-CN") ? "zh-CN" : cultures[0]);
  const hasFfmpeg = await findFfmpeg();
  const wav = output || path.join(tmpdir(), `stt-input-${Date.now()}.wav`);
  if (hasFfmpeg) {
    const ffmpeg = (await findFfmpegPath()) || "ffmpeg";
    await runCommand(ffmpeg, ["-y", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { timeout: 120_000 });
  }
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Speech",
    "$ci = [System.Globalization.CultureInfo]::GetCultureInfo($env:MODELDOCK_STT_CULTURE)",
    "$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($ci)",
    '$grammar = New-Object System.Speech.Recognition.DictationGrammar("grammar:dictation")',
    "$engine.LoadGrammar($grammar)",
    "$engine.SetInputToWaveFile($env:MODELDOCK_STT_WAV)",
    "$result = $engine.Recognize()",
    'if ($result) { Write-Output ("TEXT:" + $result.Text); Write-Output ("CONF:" + $result.Confidence) } else { Write-Output "TEXT:" }',
    "$engine.Dispose()",
  ].join("; ");
  const out = await runPowerShell(script, {
    MODELDOCK_STT_CULTURE: culture,
    MODELDOCK_STT_WAV: path.resolve(wav),
  });
  const text = (out.match(/TEXT:(.*)/) || [])[1]?.trim() || "";
  const conf = parseFloat((out.match(/CONF:(.*)/) || [])[1] || "0");
  return { text, confidence: conf, language: culture, engine: "sapi" };
}

async function ensureWav(file, output) {
  if (path.extname(file).toLowerCase() === ".wav") return file;
  if (!(await findFfmpeg())) {
    throw new Error("ffmpeg is required to convert non-WAV audio for whisper.cpp; install it with: brew install ffmpeg");
  }
  const ffmpeg = (await findFfmpegPath()) || "ffmpeg";
  const wav = output || path.join(tmpdir(), `stt-input-${Date.now()}.wav`);
  await runCommand(ffmpeg, ["-y", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { timeout: 120_000 });
  return wav;
}

async function transcribeWhisper(engine, file, language, output) {
  const lang = whisperLanguageFor(language);
  const dir = mkdtempSync(path.join(tmpdir(), "modeldock-stt-"));

  const model = await ensureWhisperModel();
  if (!model) throw new Error("whisper.cpp model is disabled. Set MODELDOCK_WHISPER_MODEL to a ggml-*.bin path or unset MODELDOCK_WHISPER_AUTO_MODEL.");
  const input = await ensureWav(file, output);
  const prefix = path.join(dir, "out");
  const args = ["-m", model, "-f", input, "-otxt", "-of", prefix];
  if (lang) args.push("-l", lang);
  await runCommand(engine.bin, args, { timeout: WHISPER_RUN_TIMEOUT_MS });
  const outFile = `${prefix}.txt`;
  if (!existsSync(outFile)) throw new Error(`whisper.cpp produced no transcript at ${outFile}`);
  return {
    text: readFileSync(outFile, "utf8").trim(),
    confidence: 1,
    language: language === "auto" ? "auto" : lang,
    engine: engine.kind,
  };
}

export async function sttTranscribe({ file = "", language = "auto", output = "" } = {}) {
  if (!file) throw new Error("hear requires a file path");
  if (!existsSync(file)) throw new Error(`audio file not found: ${file}`);
  if (process.platform === "win32") return transcribeWindows({ file, language, output });
  const engine = await probeWhisper();
  if (!engine) throw new Error((await sttStatus()).hint || "No Whisper STT engine found");
  return transcribeWhisper(engine, file, language, output);
}
