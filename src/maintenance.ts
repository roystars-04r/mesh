import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { MeshDb } from "./db.ts";
import { git, isTerminalStatus, processAlive } from "./util.ts";

export interface CleanOptions {
  keep?: number;
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export interface CleanResult {
  removed: string[];
  orphans: string[];
  kept: number;
  dryRun: boolean;
}

function readPid(path: string): number | null {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((done) => rl.question(`${question} [y/N] `, done));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function cleanRuns(workspace: string, options: CleanOptions = {}): Promise<CleanResult> {
  const root = resolve(workspace);
  const keep = Math.max(0, options.keep ?? 10);
  const db = new MeshDb(root);
  try {
    const runs = db.listRuns(5_000);
    const known = new Set(runs.map((run) => run.id));
    const removable: string[] = [];
    runs.forEach((run, index) => {
      if (!isTerminalStatus(run.status)) return;
      if (options.all || index >= keep) removable.push(run.id);
    });

    const runsDir = join(root, ".mesh", "runs");
    const orphans: string[] = [];
    if (existsSync(runsDir)) {
      for (const entry of readdirSync(runsDir)) {
        if (known.has(entry)) continue;
        const pid = readPid(join(runsDir, entry, "pid"));
        if (pid && processAlive(pid)) continue;
        orphans.push(entry);
      }
    }

    const result: CleanResult = { removed: [], orphans, kept: runs.length - removable.length, dryRun: options.dryRun === true };
    const targets = [...removable, ...orphans];
    if (targets.length === 0) return result;

    if (!options.dryRun && !options.yes) {
      if (!(await confirm(`Remove ${targets.length} run(s) from ${runsDir}?`))) {
        throw new Error("clean cancelled; rerun with --yes to skip the prompt");
      }
    }
    if (options.dryRun) {
      result.removed = targets;
      return result;
    }

    for (const id of targets) {
      rmSync(join(runsDir, id), { recursive: true, force: true });
      if (known.has(id)) db.deleteRun(id);
      result.removed.push(id);
    }
    git(["worktree", "prune"], root);
    return result;
  } finally {
    db.close();
  }
}
