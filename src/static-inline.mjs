// Placeholder used when running from source (npm test / npm run dev / node src/server.mjs).
// The release build (scripts/build.mjs) replaces this module with the frontend assets
// inlined via an esbuild plugin, so the distributed bundle is a true single file with no
// on-disk static assets. Keeping the import here lets server.mjs resolve it in every mode.
export default null;
