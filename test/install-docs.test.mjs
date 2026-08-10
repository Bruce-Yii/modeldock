import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows install instructions download a release script before execution", () => {
  for (const relativePath of ["README.md", "scripts/install.ps1"]) {
    const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /raw\.githubusercontent\.com\/architectds\/modeldock\/main\/scripts\/install\.ps1[^\r\n]*\|[^\r\n]*(?:Invoke-Expression|\biex\b)/i,
      `${relativePath} must not advertise inline execution`,
    );
    assert.match(
      source,
      /releases\/latest\/download\/install\.ps1/,
      `${relativePath} should download the published release installer`,
    );
  }
});
