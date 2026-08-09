// Config write guards, in the spirit of the DeepSeek setup script's duplicate-
// key self-check (:684-705) and change manifest (:712-722). A TOML config with
// a duplicated key makes Codex refuse to start, so ModelDock must never write
// one - and when the user's own config already carries duplicates, the write
// must stop before touching the file instead of baking the broken state in.
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

// Full-key duplicate scan: tracks the current table so both top-level and
// in-table duplicates are caught ([mcp_servers.modeldock] url= twice is just as
// fatal as two top-level model= lines). Array-of-tables ([[...]]) is treated
// as a distinct table so repeated [[entries]] do not false-positive.
export function duplicateKeys(source) {
  const counts = new Map();
  const currentTable = [""];
  const arrayTableCount = new Map();
  let depth = 0;
  for (const raw of String(source || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[[")) {
      // Each [[entry]] is a fresh array element: repeated entries are legal and
      // share the table name, so give every instance its own path (providers#1,
      // providers#2) to avoid false positives on identical per-entry keys.
      depth += 1;
      const tableName = line.slice(2, -2).trim();
      const instance = (arrayTableCount.get(tableName) || 0) + 1;
      arrayTableCount.set(tableName, instance);
      currentTable[depth] = `${tableName}#${instance}`;
      continue;
    }
    if (line.startsWith("[")) {
      depth += 1;
      currentTable[depth] = line.slice(1, -1).trim();
      continue;
    }
    if (line.startsWith("]")) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (!match) continue;
    const table = currentTable[depth] || "";
    const fullKey = table ? `${table}.${match[1]}` : match[1];
    counts.set(fullKey, (counts.get(fullKey) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

// Throws when the source would break Codex. A TOML duplicate is a hard parse
// failure at Codex startup, so the guard aborts the write before anything is
// touched (DeepSeek setup script :684-705 semantics).
export function assertConfigWriteSafe(source) {
  const duplicates = duplicateKeys(source);
  if (duplicates.length) {
    const error = new Error(`config.toml has duplicate key(s): ${duplicates.join(", ")}; Codex refuses to start on a duplicated TOML key, so the write was aborted and the file was left untouched.`);
    error.code = "DUPLICATE_TOML_KEY";
    throw error;
  }
  return source;
}

// Append-only audit trail next to the switch state: who changed the Codex
// config, when, why, and which backup/hashes it involved. Never throws - an
// audit file must not take the config switch down.
export async function appendConfigManifest(stateDir, entry) {
  try {
    await mkdir(stateDir, { recursive: true });
    const file = path.join(stateDir, "config-manifest.jsonl");
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
