#!/usr/bin/env node
// ModelDock doctor CLI: prints the 10-point check list and exits 1 when any
// check fails (warnings do not fail the run). Never prints credential values.
//   node scripts/doctor.mjs          human-readable report
//   node scripts/doctor.mjs --json   machine-readable { checks, exitCode }
import { checkDoctor, doctorExitCode } from "../src/doctor.mjs";

const jsonOutput = process.argv.includes("--json");

const checks = await checkDoctor();
const exitCode = doctorExitCode(checks);

if (jsonOutput) {
  process.stdout.write(JSON.stringify({ checks, exitCode }, null, 2) + "\n");
} else {
  for (const check of checks) {
    const mark = check.status === "ok" ? "[ok]  " : check.status === "warn" ? "[warn]" : "[fail]";
    process.stdout.write(`${mark} ${check.name}: ${check.detail}\n`);
    if (check.fix) process.stdout.write(`       fix: ${check.fix}\n`);
  }
  process.stdout.write(`\n${checks.length} checks, ${checks.filter((c) => c.status === "fail").length} failed, ${checks.filter((c) => c.status === "warn").length} warnings\n`);
}
process.exit(exitCode);
