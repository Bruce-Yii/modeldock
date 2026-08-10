#!/usr/bin/env node
// One-time migration from the pre-0.2.3 single memory.db to node databases.
//
//   node scripts/migrate-memory-nodes.mjs
//   node scripts/migrate-memory-nodes.mjs --memory-dir "D:\path\to\memory"
//
// The legacy database is copied to a timestamped backup, then archived beside
// itself after a successful migration. No memory markdown or index file is
// generated.

import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { migrateLegacyMemory } from "../src/memory.mjs";

const argv = process.argv.slice(2);
const memoryIndex = argv.indexOf("--memory-dir");
const memoryDir = memoryIndex >= 0 && argv[memoryIndex + 1]
  ? path.resolve(argv[memoryIndex + 1])
  : loadConfig().memoryDir;

const result = migrateLegacyMemory({ memoryDir });
console.log(JSON.stringify(result, null, 2));
