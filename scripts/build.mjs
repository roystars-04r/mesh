#!/usr/bin/env node
// Compile src/*.ts to dist/*.js and copy the runtime assets the CLI reads.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules", ".bin", "tsc");
const result = spawnSync(tsc, ["-p", join(root, "tsconfig.build.json")], {
  stdio: "inherit",
  cwd: root,
});
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(join(root, "dist"), { recursive: true });
copyFileSync(join(root, "src", "web.html"), join(root, "dist", "web.html"));
console.log("built dist/");
