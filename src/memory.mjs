// Persistent memory vault for ModelDock: capture, index, and recall.
//
// Write path is fully automatic and cheap: files are identity-hashed, only new
// revisions create content units, and the old revision's units flip to
// `superseded`. Read path is a permissive FTS5 recall (`recall_memory` MCP
// tool) that lets the model decide relevance; the vault never claims truth.
// The schema is a trimmed form of Backed 1.0's capture model: sources,
// source_items, source_revisions, content_units, plus an FTS5 index.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  native_location TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(adapter, native_location)
);
CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  native_id TEXT NOT NULL,
  path TEXT,
  kind TEXT,
  UNIQUE(source_id, native_id)
);
CREATE TABLE IF NOT EXISTS source_revisions (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  revision INTEGER NOT NULL,
  blob_sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  supersedes_revision_id TEXT,
  UNIQUE(source_item_id, revision)
);
CREATE TABLE IF NOT EXISTS content_units (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_revisions(id),
  kind TEXT NOT NULL,
  head TEXT,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  locator TEXT NOT NULL,
  trust_class TEXT NOT NULL,
  memory_state TEXT NOT NULL DEFAULT 'captured',
  scope_paths TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_revision ON content_units(source_revision_id);
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(id UNINDEXED, head, text);
CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

const KNOWN_MEMORY_FILES = [
  { name: "MEMORY.md", trustClass: "trusted_instruction" },
  { name: "memory_summary.md", trustClass: "agent_output" },
  { name: "raw_memories.md", trustClass: "agent_output" },
];

const HEADING_RE = /^#(?!#)\s+(.+?)\s*$/;

function stableId(prefix, ...parts) {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function stripVaultPrefix(raw) {
  return String(raw || "").replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
}

function normalizeScope(dir) {
  return stripVaultPrefix(dir).toLowerCase();
}

function extractScopes(text) {
  const match = /applies_to:\s*cwd=([^\n]+)/i.exec(String(text || ""));
  if (!match) return [];
  return match[1]
    .split("|")
    .map((raw) => normalizeScope(String(raw || "").split(";")[0]))
    .filter(Boolean);
}

function splitUnits(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { head: match[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else if (line.trim()) {
      sections.push({ head: null, body: [line] });
    }
  }
  if (current) sections.push(current);
  return sections;
}

function formatHits(hits) {
  if (!hits.length) return "MEMORY_RECALL no hits";
  const lines = [`MEMORY_RECALL ${hits.length} hits`];
  hits.forEach((hit, index) => {
    let locator = {};
    try { locator = JSON.parse(hit.locator || "{}"); } catch { /* keep default */ }
    const source = locator.source || "memory";
    const heading = hit.head || "(untitled)";
    const snippet = String(hit.text || "").replace(/\s+/g, " ").trim().slice(0, 1200);
    lines.push("");
    lines.push(`[${index + 1}] ${heading} (${hit.trust_class}/${hit.memory_state})`);
    lines.push(`key: ${hit.key || "-"}`);
    lines.push(`source: ${source}${locator.heading ? ` > ${locator.heading}` : ""}`);
    lines.push(snippet);
  });
  return lines.join("\n");
}

export class MemoryStore {
  constructor({ dbPath }) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  #upsert(table, id, columns) {
    const keys = ["id", ...Object.keys(columns)];
    const sql = `INSERT OR IGNORE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
    this.db.prepare(sql).run(id, ...Object.keys(columns).map((key) => columns[key]));
  }

  // Capture one text file as an immutable source revision. A file whose bytes
  // are unchanged is a no-op; a changed file creates a new revision and marks
  // the previous revision's units superseded.
  captureFile({ filePath, sourceDir, adapter = "folder", trustClass = "external_content" }) {
    const text = readFileSync(filePath, "utf8");
    return this.captureText({
      text,
      sourceDir,
      fileName: path.basename(filePath),
      filePath,
      adapter,
      trustClass,
    });
  }

  // Core write path shared by file capture and explicit store_memory writes.
  // A `key` makes the item updatable (new revisions supersede the old one);
  // without a key the item is a standalone entry that only dedupes on
  // identical content.
  captureText({ text, sourceDir, fileName, filePath = null, adapter, trustClass, itemKey = null }) {
    const sha = createHash("sha256").update(text).digest("hex");
    const sourceDirAbs = sourceDir ? path.resolve(sourceDir) : "<global>";
    const sourceId = stableId("src", adapter, sourceDirAbs);
    this.#upsert("sources", sourceId, { adapter, native_location: sourceDirAbs, created_at: new Date().toISOString() });

    const itemSeed = itemKey || fileName;
    const itemId = stableId("item", sourceId, itemSeed);
    this.#upsert("source_items", itemId, {
      source_id: sourceId,
      native_id: itemSeed,
      path: filePath,
      kind: adapter === "agent_written" ? "memory" : "file",
    });

    const previous = this.db
      .prepare("SELECT id, revision, blob_sha256 FROM source_revisions WHERE source_item_id = ? ORDER BY revision DESC LIMIT 1")
      .get(itemId);
    if (previous && previous.blob_sha256 === sha) return { skipped: true, revision: previous.revision, sha };

    const revision = previous ? previous.revision + 1 : 1;
    const revisionId = stableId("rev", itemId, revision);
    const observedAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO source_revisions (id, source_item_id, revision, blob_sha256, size, observed_at, supersedes_revision_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(revisionId, itemId, revision, sha, Buffer.byteLength(text), observedAt, previous?.id || null);
    if (previous) {
      this.db.prepare("UPDATE content_units SET memory_state = 'superseded' WHERE source_revision_id = ?").run(previous.id);
    }

    const fileScopes = extractScopes(text);
    const insertUnit = this.db.prepare(
      "INSERT INTO content_units (id, source_revision_id, kind, head, text, text_hash, locator, trust_class, memory_state, scope_paths, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'captured', ?, ?)",
    );
    const insertFts = this.db.prepare("INSERT INTO content_fts (id, head, text) VALUES (?, ?, ?)");
    const sections = splitUnits(text);
    let units = 0;
    sections.forEach((section, index) => {
      const body = section.body.join("\n").trim();
      if (!body) return;
      const unitId = stableId("cu", revisionId, index);
      const textHash = createHash("sha256").update(body).digest("hex");
      const locator = JSON.stringify({ source: fileName, heading: section.head, index });
      const sectionScopes = section.body.some((line) => /applies_to/i.test(line))
        ? extractScopes(section.body.join("\n"))
        : fileScopes;
      insertUnit.run(unitId, revisionId, "section", section.head, body, textHash, locator, trustClass, sectionScopes.join("|"), observedAt);
      insertFts.run(unitId, section.head || "", body);
      units += 1;
    });
    return { skipped: false, revision, units, sha };
  }

  // Explicit write path: the model asks to persist something from the
  // conversation. A stable `key` updates an existing entry; without it every
  // store is a standalone item, deduped on identical kind + content.
  storeMemory({ content, scopeDir = null, kind = "knowledge", key = null }) {
    const text = String(content || "").trim();
    if (!text) throw new Error("store_memory requires non-empty content");
    const heading = String(kind || "knowledge").trim() || "knowledge";
    const scopeLine = scopeDir ? `applies_to: cwd=${scopeDir}` : "";
    const marked = [`# ${heading}`, scopeLine, text].filter(Boolean).join("\n\n");
    const sha = createHash("sha256").update(marked).digest("hex");
    const fileName = `${heading}:${sha.slice(0, 16)}`;
    const captured = this.captureText({
      text: marked,
      sourceDir: scopeDir || null,
      fileName,
      adapter: "agent_written",
      trustClass: "agent_output",
      itemKey: key || null,
    });
    const result = {
      ok: true,
      stored: !captured.skipped,
      revision: captured.revision,
      units: captured.units || 0,
      kind: heading,
      scope: scopeDir || "global",
    };
    this.#recordEvent("store_memory", result.scope, {
      stored: result.stored,
      revision: result.revision,
      units: result.units,
      kind: heading,
      key: key || null,
    });
    return result;
  }

  // Capture the Codex client's persistent memory files (~/.codex/memories).
  // MEMORY.md is trusted instruction material; summaries and raw memories are
  // agent output and stay reference material.
  captureCodexMemories(codexHome) {
    const dir = path.join(codexHome, "memories");
    if (!existsSync(dir)) return { ok: false, error: `no memories directory: ${dir}` };
    const result = { ok: true, scanned: 0, captured: 0, skipped: 0, units: 0, files: [] };
    for (const file of KNOWN_MEMORY_FILES) {
      const filePath = path.join(dir, file.name);
      if (!existsSync(filePath)) continue;
      result.scanned += 1;
      const captured = this.captureFile({
        filePath,
        sourceDir: dir,
        adapter: "codex-memories",
        trustClass: file.trustClass,
      });
      result.units += captured.units || 0;
      if (captured.skipped) result.skipped += 1;
      else result.captured += 1;
      result.files.push({ name: file.name, ...captured });
    }
    if (result.ok) {
      this.#recordEvent("capture", dir, {
        scanned: result.scanned,
        captured: result.captured,
        skipped: result.skipped,
        units: result.units,
        files: result.files.map((file) => file.name),
      });
    }
    return result;
  }

  // Permissive recall: BM25 over the FTS index. With a working directory the
  // recall is layered - project-scoped hits come first, then global (unscoped)
  // units fill the remaining slots, so project noise never drowns global
  // preferences and a miss falls back upward. Without a scope (a direct /mcp
  // call that carries no working-directory context) it stays a full recall.
  // scopeOnly (used by the stdio bridge's MODELDOCK_MEMORY_SCOPE isolation
  // mode) restricts recall to the project bucket and never falls back to
  // global, so a disposable test memory can neither read nor pollute the
  // shared vault.
  search({ query, scopeDir = null, limit = 8, scopeOnly = false } = {}) {
    const terms = String(query || "").match(/[\p{L}\p{N}_]+/gu) || [];
    if (!terms.length) throw new Error("recall_memory requires a non-empty query");
    const quote = (term) => `"${term.replace(/"/g, "")}"`;
    const exact = terms.map(quote).join(" AND ");
    const loose = terms.map(quote).join(" OR ");
    const sql = `
      SELECT u.id, u.head, u.text, u.trust_class, u.memory_state, u.locator, u.scope_paths,
             si.native_id AS key,
             bm25(content_fts) AS score
      FROM content_fts f
      JOIN content_units u ON u.id = f.id
      JOIN source_revisions sr ON sr.id = u.source_revision_id
      JOIN source_items si ON si.id = sr.source_item_id
      WHERE content_fts MATCH ?
        AND u.memory_state = 'captured'
      ORDER BY score DESC
      LIMIT ?
    `;
    const limitRows = Math.max(limit * 10, 50);
    // Strict AND first for precision; a query phrased with extra words that are
    // not in the index (e.g. "deepswe best practices" against a note that only
    // says "deepswe") must not empty the recall, so fall back to permissive OR.
    // bm25 keeps rows matching more terms on top.
    let rows = this.db.prepare(sql).all(exact, limitRows);
    if (!rows.length) rows = this.db.prepare(sql).all(loose, limitRows);
    const cwd = normalizeScope(scopeDir);
    if (!cwd) {
      if (scopeOnly) return { count: 0, text: "MEMORY_RECALL no hits" };
      const hits = rows.slice(0, limit);
      return { count: hits.length, text: formatHits(hits) };
    }
    const projectHits = rows.filter(
      (row) => String(row.scope_paths || "") && matchesScope(row.scope_paths, cwd),
    );
    if (scopeOnly) {
      const hits = projectHits.slice(0, limit);
      return { count: hits.length, text: formatHits(hits) };
    }
    const globalHits = rows.filter((row) => !String(row.scope_paths || ""));
    const hits = [...projectHits, ...globalHits].slice(0, limit);
    return { count: hits.length, text: formatHits(hits) };
  }

  status() {
    const count = (table) => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return {
      enabled: true,
      dbPath: this.dbPath,
      sources: count("sources"),
      source_items: count("source_items"),
      source_revisions: count("source_revisions"),
      content_units: count("content_units"),
      events: count("memory_events"),
    };
  }

  #recordEvent(kind, scope, detail) {
    const id = stableId("evt", kind, scope, detail, Date.now());
    this.db
      .prepare("INSERT INTO memory_events (id, kind, scope, detail, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, kind, scope, JSON.stringify(detail), new Date().toISOString());
  }

  // Lightweight event feed for the memory page: newest first.
  recentEvents(limit = 50) {
    return this.db
      .prepare(`
        SELECT kind, scope, detail, created_at
        FROM memory_events
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => {
        let detail = {};
        try { detail = JSON.parse(row.detail || "{}"); } catch { /* keep default */ }
        return { ...row, detail };
      });
  }

  // Flat view of captured units for the memory page, newest revision first.
  contentView(limit = 100) {
    return this.db
      .prepare(`
        SELECT u.head, u.kind, u.trust_class, u.memory_state, u.scope_paths,
               u.created_at, s.adapter AS source_adapter, i.native_id, r.revision,
               substr(u.text, 1, 400) AS text
        FROM content_units u
        JOIN source_revisions r ON r.id = u.source_revision_id
        JOIN source_items i ON i.id = r.source_item_id
        JOIN sources s ON s.id = i.source_id
        ORDER BY r.observed_at DESC, u.rowid DESC
        LIMIT ?
      `)
      .all(limit);
  }
}

function matchesScope(scopePaths, cwd) {
  const paths = String(scopePaths || "").split("|").filter(Boolean);
  if (!paths.length) return true;
  return paths.some((scopePath) => scopePath === cwd || cwd.startsWith(`${scopePath}\\`));
}

// Open the vault only when MODELDOCK_MEMORY is enabled; null keeps the gateway
// in its thin default shape.
export function memoryStoreFor(config) {
  if (!config?.memoryEnabled) return null;
  return new MemoryStore({ dbPath: path.join(config.memoryDir, "memory.db") });
}
