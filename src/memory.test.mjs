import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { MemoryStore } from "./memory.mjs";

function memoryDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-memory-test-"));
  const memories = path.join(dir, "memories");
  mkdirSync(memories, { recursive: true });
  return { dir, memories };
}

function writeFixture(memories, { baseline = true } = {}) {
  if (baseline) {
    writeFileSync(path.join(memories, "MEMORY.md"), [
      "# Task Group: StockScan QCM current baseline",
      "",
      "scope: baseline memory for stockscan.",
      "applies_to: cwd=\\\\?\\D:\\projects\\stockscan|\\\\?\\D:\\projects\\stockscan-backtest; reuse_rule=current until frozen.",
      "",
      "## Reusable knowledge",
      "",
      "The current QCM baseline is the DIVO cash-sleeve version with quality >= 280.",
      "",
    ].join("\n"), "utf8");
  }
  writeFileSync(path.join(memories, "memory_summary.md"), [
    "# Rolling summary",
    "",
    "General notes apply to every project.",
    "",
  ].join("\n"), "utf8");
}

test("capture indexes memory files and search finds them", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  try {
    const captured = store.captureCodexMemories(dir);
    assert.equal(captured.ok, true);
    assert.equal(captured.scanned, 2);
    assert.equal(captured.captured, 2);
    assert.equal(captured.skipped, 0);
    assert.ok(captured.units >= 2, `expected at least 2 units, got ${captured.units}`);

    const status = store.status();
    assert.equal(status.sources, 1);
    assert.equal(status.source_items, 2);
    assert.equal(status.source_revisions, 2);
    assert.equal(status.content_units, captured.units);

    const hit = store.search({ query: "DIVO cash-sleeve baseline" });
    assert.equal(hit.count, 1);
    assert.match(hit.text, /QCM current baseline/);
    assert.match(hit.text, /trusted_instruction/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall filters by working-directory scope", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  try {
    store.captureCodexMemories(dir);

    const scoped = store.search({ query: "baseline", scopeDir: "D:\\projects\\stockscan" });
    assert.ok(scoped.count >= 1, "scoped project can recall its baseline");
    assert.match(scoped.text, /StockScan/);

    const other = store.search({ query: "baseline", scopeDir: "D:\\projects\\other-project" });
    assert.ok(!other.text.includes("QCM current baseline"), "other project does not see stockscan memory");

    const unscoped = store.search({ query: "every project" });
    assert.equal(unscoped.count, 1, "unscoped unit matches everywhere");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storeMemory persists an explicit memory scoped to a project", () => {
  const { dir } = memoryDir();
  const store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  try {
    const saved = store.storeMemory({
      content: "The QCM baseline uses the DIVO cash-sleeve version with quality >= 280.",
      scopeDir: "D:\\projects\\stockscan",
      kind: "baseline",
    });
    assert.equal(saved.stored, true);
    assert.equal(saved.revision, 1);
    assert.equal(saved.units, 1);
    assert.equal(saved.scope, "D:\\projects\\stockscan");

    const hit = store.search({ query: "DIVO baseline", scopeDir: "D:\\projects\\stockscan" });
    assert.equal(hit.count, 1);
    assert.match(hit.text, /\[1\] baseline/);
    assert.match(hit.text, /agent_output/);

    const other = store.search({ query: "DIVO baseline", scopeDir: "D:\\projects\\other-project" });
    assert.equal(other.count, 0, "scoped memory stays out of other projects");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storeMemory dedupes identical content and supersedes via a stable key", () => {
  const { dir } = memoryDir();
  const store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  try {
    const first = store.storeMemory({ content: "Prefer fast iteration.", kind: "preference", key: "iter-style" });
    assert.equal(first.stored, true);

    const duplicate = store.storeMemory({ content: "Prefer fast iteration.", kind: "preference", key: "iter-style" });
    assert.equal(duplicate.stored, false, "identical content with the same key is a no-op");

    const updated = store.storeMemory({
      content: "Prefer fast iteration with daily checkpoints.",
      kind: "preference",
      key: "iter-style",
    });
    assert.equal(updated.stored, true);
    assert.equal(updated.revision, 2, "same key creates a new revision");

    const hit = store.search({ query: "checkpoints" });
    assert.equal(hit.count, 1, "superseded revision is not recalled");
    assert.match(hit.text, /daily checkpoints/);

    const states = store.db.prepare("SELECT memory_state, COUNT(*) AS n FROM content_units GROUP BY memory_state").all();
    const byState = Object.fromEntries(states.map((row) => [row.memory_state, row.n]));
    assert.ok(byState.superseded >= 1, "old key revision is marked superseded");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory events and content view track stores and captures", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  try {
    store.captureCodexMemories(dir);
    store.storeMemory({ content: "Remember the DIVO baseline.", scopeDir: "D:\\projects\\stockscan", kind: "baseline" });

    const events = store.recentEvents(10);
    assert.ok(events.some((event) => event.kind === "capture"), "capture event recorded");
    assert.ok(
      events.some((event) => event.kind === "store_memory" && event.scope === "D:\\projects\\stockscan"),
      "store event recorded with scope",
    );
    assert.ok(events.some((event) => event.detail.stored === true), "store event carries detail");

    const view = store.contentView(50);
    assert.ok(view.some((unit) => unit.head === "baseline"), "stored memory appears in content view");
    assert.ok(view.some((unit) => unit.source_adapter === "codex-memories"), "captured files appear in content view");
    assert.ok(view.every((unit) => typeof unit.text === "string" && unit.text.length <= 400), "content view truncates text");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unchanged files are no-ops and edits create superseded revisions", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  try {
    store.captureCodexMemories(dir);
    const second = store.captureCodexMemories(dir);
    assert.equal(second.skipped, 2, "identical bytes skip");

    writeFileSync(path.join(memories, "MEMORY.md"), [
      "# Task Group: StockScan QCM current baseline",
      "",
      "applies_to: cwd=\\\\?\\D:\\projects\\stockscan; reuse_rule=current until frozen.",
      "",
      "The baseline was updated: DIVO cash sleeve with a new threshold.",
      "",
    ].join("\n"), "utf8");
    const third = store.captureCodexMemories(dir);
    assert.equal(third.captured, 1);
    assert.equal(store.status().source_revisions, 3, "MEMORY.md gained a second revision");

    const latest = store.search({ query: "updated threshold", scopeDir: "D:\\projects\\stockscan" });
    assert.equal(latest.count, 1);
    const states = store.db.prepare("SELECT memory_state, COUNT(*) AS n FROM content_units GROUP BY memory_state").all();
    const byState = Object.fromEntries(states.map((row) => [row.memory_state, row.n]));
    assert.ok(byState.superseded >= 1, "old revision units are superseded");
    assert.ok(byState.captured >= 1, "new revision units are captured");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search rejects empty queries and punctuation-only input", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  try {
    store.captureCodexMemories(dir);
    assert.throws(() => store.search({ query: "   " }), /non-empty query/);
    assert.throws(() => store.search({ query: "--- !!!" }), /non-empty query/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
