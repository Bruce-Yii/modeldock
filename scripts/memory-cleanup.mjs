// Delete memory units scoped to a disposable bucket (e.g. the benchmark scope
// written through MODELDOCK_MEMORY_SCOPE), so a test run leaves no residue in
// the shared vault. Requires MODELDOCK_MEMORY=1.
//
//   node scripts/memory-cleanup.mjs --scope "D:\bench\deepswe"
//
// The gateway holds memory.db open; WAL mode lets a second connection write
// concurrently and busy_timeout waits for the writer instead of failing.
// content_fts is a plain FTS5 table (not external content), so its rows must be
// removed explicitly alongside content_units. source_* rows are left as
// orphans: they do not participate in recall.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";

const argv = process.argv.slice(2);
const idx = argv.indexOf("--scope");
if (idx === -1 || !argv[idx + 1]) {
  console.error("usage: node scripts/memory-cleanup.mjs --scope <scope>");
  process.exit(2);
}
const scope = argv[idx + 1];

const config = loadConfig();
if (!config.memoryEnabled) {
  console.error("memory is disabled; set MODELDOCK_MEMORY=1 first");
  process.exit(1);
}

const dbPath = path.join(config.memoryDir, "memory.db");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");

const like = `%${scope.toLowerCase()}%`;
const before = db.prepare("SELECT COUNT(*) AS n FROM content_units WHERE scope_paths LIKE ?").get(like).n;

db.exec("BEGIN");
const nFts = db
  .prepare("DELETE FROM content_fts WHERE id IN (SELECT id FROM content_units WHERE scope_paths LIKE ?)")
  .run(like).changes;
const nUnits = db.prepare("DELETE FROM content_units WHERE scope_paths LIKE ?").run(like).changes;
db.exec("COMMIT");

console.log(`memory-cleanup scope=${JSON.stringify(scope)} deleted units=${nUnits} fts=${nFts} (was ${before})`);
