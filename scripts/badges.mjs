#!/usr/bin/env node
// Recompute the README coverage badge from a real test run.
//
// No third-party coverage service and no telemetry: the tests run here, the
// "all files" line of Node's built-in coverage report is parsed, and the result
// is written to badges/coverage.json. shields.io's endpoint badge reads that
// file over raw.githubusercontent.com.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const tests = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `test/${name}`);

if (tests.length === 0) {
  console.error("coverage badge not updated: no test files found");
  process.exit(1);
}

const run = spawnSync(
  process.execPath,
  ["--test", "--experimental-test-coverage", ...tests],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
// e.g. "ℹ all files       |  68.72 |    65.07 |   73.48 |"
const match = output.match(/all files\s*\|\s*([\d.]+)/);

if (run.status !== 0 || !match) {
  console.error(output.trim().split("\n").slice(-30).join("\n"));
  console.error("coverage badge not updated: tests failed or coverage line missing");
  process.exit(1);
}

const pct = Number(match[1]);
const color =
  pct >= 90
    ? "brightgreen"
    : pct >= 80
      ? "green"
      : pct >= 70
        ? "yellowgreen"
        : pct >= 60
          ? "yellow"
          : pct >= 50
            ? "orange"
            : "red";

const badge = {
  schemaVersion: 1,
  label: "line coverage",
  message: `${pct.toFixed(1)}%`,
  color,
};

const target = join(root, "badges", "coverage.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(badge, null, 2)}\n`);
console.log(`line coverage ${badge.message} (${color}) -> badges/coverage.json`);
