// Release build: bundle the gateway into a single self-contained ESM file
// (dist/modeldock.mjs) with the dashboard frontend inlined.
//
// The src/static-inline.mjs placeholder (null in a git checkout) is replaced at build
// time by a generated module exporting { public: {...}, assets: {...} }: text files as
// strings, binaries as Buffers. server.mjs serves the dashboard from that tree when it
// is present, so the bundle needs no on-disk public/ or assets/ directories.
//
// Usage: node scripts/build.mjs   (or: npm run build)

import { build } from "esbuild";
import { readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "modeldock.mjs");

const TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".svg", ".json", ".txt"]);

// Only these top-level assets ship in the bundle. Vision eval images stay on disk and
// are dev-only: loadTaskImage returns null when they are absent and the eval skips.
const INLINE_ASSETS = ["dashboard.png", "icon.png", "icon.ico"];

function inlineTree(dir, files) {
  const entries = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const ext = path.extname(file).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) {
      entries.push(`  ${JSON.stringify(file)}: ${JSON.stringify(readFileSync(full, "utf8"))}`);
    } else {
      entries.push(`  ${JSON.stringify(file)}: Buffer.from(${JSON.stringify(readFileSync(full).toString("base64"))}, "base64")`);
    }
  }
  return `{\n${entries.join(",\n")}\n}`;
}

function generateStaticModule() {
  const publicDir = path.join(root, "public");
  const publicFiles = readdirSync(publicDir).filter((f) => statSync(path.join(publicDir, f)).isFile());
  const assetsDir = path.join(root, "assets");
  const assetFiles = INLINE_ASSETS.filter((f) => {
    try { return statSync(path.join(assetsDir, f)).isFile(); } catch { return false; }
  });
  return [
    `import { Buffer } from "node:buffer";`,
    `export default {`,
    `public: ${inlineTree(publicDir, publicFiles)},`,
    `assets: ${inlineTree(assetsDir, assetFiles)},`,
    `};`,
  ].join("\n");
}

const staticInlinePlugin = {
  name: "static-inline",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /static-inline\.mjs$/ }, () => ({
      contents: generateStaticModule(),
      loader: "js",
    }));
  },
};

mkdirSync(path.dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "src", "server.mjs")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  minify: false,
  logLevel: "info",
  plugins: [staticInlinePlugin],
  // CJS dependencies (express) use dynamic require internally; give the ESM bundle a
  // real require implementation.
  banner: {
    js: `import { createRequire as __modeldockCreateRequire } from "node:module";\nconst require = __modeldockCreateRequire(import.meta.url);`,
  },
});

if (result.errors.length) process.exit(1);

const size = statSync(outfile).size;
console.log(`built ${path.relative(root, outfile)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
