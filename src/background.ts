import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshDb } from "./db.ts";
import { ensureDir, newId, nowIso } from "./util.ts";

export interface BackgroundRunOptions {
  goal: string;
  workflow: string;
  workspace: string;
  dryRun?: boolean;
  maxCostUsd?: number;
  approveDangerous?: boolean;
  notify?: string;
}

export interface BackgroundRun {
  runId: string;
  logPath: string;
  pid: number;
}

/** Path of the CLI entry, so background children always run this checkout. */
export function cliEntry(): string {
  return fileURLToPath(new URL("./cli.ts", import.meta.url));
}

/**
 * Start a run in a detached child process and return immediately.
 * Shared by the MCP server and the web dashboard.
 */
export function startBackgroundRun(options: BackgroundRunOptions): BackgroundRun {
  const workspace = resolve(options.workspace);
  const runId = newId("run");
  const runDir = join(workspace, ".mesh", "runs", runId);
  ensureDir(runDir);
  const stamp = nowIso();
  const db = new MeshDb(workspace);
  try {
    db.upsertRun({
      id: runId,
      goal: options.goal,
      workflow: options.workflow,
      status: "queued",
      source_root: workspace,
      workspace,
      created_at: stamp,
      updated_at: stamp,
      pid: null,
    });
    db.addEvent(runId, null, "run.queued", { goal: options.goal, workflow: options.workflow });
  } finally {
    db.close();
  }

  const logPath = join(runDir, "runner.log");
  const fd = openSync(logPath, "a");
  const args = [
    cliEntry(),
    "run",
    options.goal,
    "--workflow",
    options.workflow,
    "--workspace",
    workspace,
    "--run-id",
    runId,
    "--quiet",
  ];
  if (options.dryRun) args.push("--dry-run");
  if (options.maxCostUsd !== undefined) args.push("--max-cost", String(options.maxCostUsd));
  if (options.notify) args.push("--notify", options.notify);
  if (options.approveDangerous) args.push("--yes");

  const child = spawn(process.execPath, args, {
    cwd: workspace,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env },
  });
  const pid = child.pid ?? 0;
  child.on("error", (error) => {
    const failed = new MeshDb(workspace);
    try {
      failed.updateRunStatus(runId, "failed", { clearPid: true });
      failed.addEvent(runId, null, "run.error", { message: error.message });
    } finally {
      failed.close();
    }
  });
  child.unref();
  closeSync(fd);
  return { runId, logPath, pid };
}
