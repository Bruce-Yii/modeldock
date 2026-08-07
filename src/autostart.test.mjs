import test from "node:test";
import assert from "node:assert/strict";
import { plistXml } from "./autostart.mjs";

test("macOS plist launches the shell wrapper with a launchd-safe node environment", () => {
  const xml = plistXml("/Users/me/.modeldock/scripts/start-hidden.sh", "/Users/me/.modeldock", {
    nodePath: "/usr/local/Cellar/node/25.4.0/bin/node",
    tmpDir: "/tmp",
  });

  assert.match(xml, /<key>ProgramArguments<\/key>/);
  assert.match(xml, /<string>\/bin\/sh<\/string>/);
  assert.match(xml, /<string>\/Users\/me\/\.modeldock\/scripts\/start-hidden\.sh<\/string>/);
  assert.doesNotMatch(xml, /<string>\/usr\/local\/Cellar\/node\/25\.4\.0\/bin\/node<\/string>\s*<string>\/Users\/me\/\.modeldock\/dist\/modeldock\.mjs/);
  assert.match(xml, /<key>MODELDOCK_NODE_PATH<\/key><string>\/usr\/local\/Cellar\/node\/25\.4\.0\/bin\/node<\/string>/);
  assert.match(xml, /\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/);
});
