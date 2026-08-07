import test from "node:test";
import assert from "node:assert/strict";
import { sttStatus, whisperLanguageFor } from "./stt.mjs";

test("whisperLanguageFor maps locales to whisper language codes", () => {
  assert.equal(whisperLanguageFor("auto"), "");
  assert.equal(whisperLanguageFor("zh-CN"), "zh");
  assert.equal(whisperLanguageFor("en-US"), "en");
  assert.equal(whisperLanguageFor("ja-JP"), "ja");
});

test("sttStatus reports a configured whisper.cpp engine and model", async (t) => {
  if (process.platform === "win32") return t.skip("whisper.cpp detection is POSIX-only");
  const previousBin = process.env.MODELDOCK_WHISPER_BIN;
  const previousModel = process.env.MODELDOCK_WHISPER_MODEL;
  process.env.MODELDOCK_WHISPER_BIN = "/bin/echo";
  process.env.MODELDOCK_WHISPER_MODEL = "/bin/echo";
  try {
    const status = await sttStatus();
    assert.equal(status.engine, "whisper-cpp");
    assert.equal(status.model, "/bin/echo");
    assert.ok(status.available);
  } finally {
    if (previousBin === undefined) delete process.env.MODELDOCK_WHISPER_BIN;
    else process.env.MODELDOCK_WHISPER_BIN = previousBin;
    if (previousModel === undefined) delete process.env.MODELDOCK_WHISPER_MODEL;
    else process.env.MODELDOCK_WHISPER_MODEL = previousModel;
  }
});
