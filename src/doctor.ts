import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, configPath } from "./config.ts";
import { runCommand } from "./util.ts";

export interface DoctorRow {
  name: string;
  ok: boolean;
  detail: string;
}

export function doctor(workspace: string): DoctorRow[] {
  const root = resolve(workspace);
  const rows: DoctorRow[] = [];
  rows.push({
    name: "node",
    ok: Number(process.versions.node.split(".")[0]) >= 24,
    detail: process.version,
  });
  const git = runCommand("git", ["--version"], root, 5_000);
  rows.push({
    name: "git",
    ok: git.status === 0,
    detail: git.status === 0 ? git.stdout.trim() : git.stderr.trim() || "not found",
  });
  rows.push({
    name: "mesh.json",
    ok: existsSync(configPath(root)),
    detail: existsSync(configPath(root)) ? configPath(root) : `missing at ${configPath(root)}`,
  });
  rows.push({
    name: ".mesh",
    ok: existsSync(join(root, ".mesh")) || true,
    detail: "run data is stored under .mesh/ (created on first run)",
  });

  let config;
  try {
    config = loadConfig(root);
  } catch (error) {
    rows.push({ name: "config", ok: false, detail: String(error instanceof Error ? error.message : error) });
    return rows;
  }

  for (const [id, agent] of Object.entries(config.agents)) {
    const result = runCommand(agent.command, ["--version"], root, 8_000);
    const output = `${result.stdout}\n${result.stderr}`.trim().split("\n")[0] ?? "";
    const found = result.status === 0 || Boolean(output);
    rows.push({
      name: id,
      ok: found,
      detail: found ? `${agent.command}  ${output}` : `${agent.command} not found or not runnable`,
    });
  }
  return rows;
}

export function printDoctor(rows: DoctorRow[]): void {
  const width = Math.max(...rows.map((row) => row.name.length), 8);
  for (const row of rows) {
    console.log(`${row.ok ? "✓" : "✗"} ${row.name.padEnd(width)}  ${row.detail}`);
  }
  const failed = rows.filter((row) => !row.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed. Install the missing CLI or fix mesh.json.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed.");
  }
}
