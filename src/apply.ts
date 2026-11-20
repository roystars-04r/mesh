import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MeshDb } from "./db.ts";
import type { ArtifactRecord, RunRecord } from "./types.ts";
import { git, hasGitHead, isGitRepo, nowIso, rebasePath, runCommand } from "./util.ts";

export interface ApplyOptions {
  runId: string;
  step?: string;
  check?: boolean;
}

export interface ApplyResult {
  runId: string;
  patchPath: string;
  mode: "git" | "patch";
  files: string[];
  applied: boolean;
}

/** Strip absolute run-dir prefixes from copy-mode patch headers, so -p1 works. */
export function normalizePatch(patch: string, runDir: string): string {
  const prefix = `${resolve(runDir)}/`;
  return patch
    .split("\n")
    .map((line) => {
      if ((line.startsWith("--- ") || line.startsWith("+++ ")) && line.includes(prefix)) {
        return line.replaceAll(prefix, "");
      }
      return line;
    })
    .join("\n");
}

export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).split("\t")[0].trim();
    if (!raw || raw === "/dev/null") continue;
    const cleaned = raw.replace(/^[ab]\//, "");
    files.add(cleaned);
  }
  return [...files].sort();
}

function pickArtifact(artifacts: ArtifactRecord[], step?: string): ArtifactRecord | undefined {
  const diffs = artifacts.filter((artifact) => artifact.kind === "diff");
  if (!diffs.length) return undefined;
  if (step) {
    const wanted = diffs.filter(
      (artifact) => artifact.step_id === step || artifact.step_id === `${artifact.run_id}:${step}`,
    );
    return wanted.at(-1);
  }
  return diffs.at(-1);
}

export function applyRun(workspace: string, options: ApplyOptions): ApplyResult {
  const root = resolve(workspace);
  const db = new MeshDb(root);
  try {
    const run: RunRecord | undefined = db.getRun(options.runId);
    if (!run) throw new Error(`run not found: ${options.runId}`);
    if (resolve(run.source_root) !== root) {
      throw new Error(
        `run ${run.id} was created in ${run.source_root}; run "mesh apply" from that workspace (or pass --workspace)`,
      );
    }
    const artifact = pickArtifact(db.getArtifacts(run.id), options.step);
    if (!artifact) {
      throw new Error(options.step ? `no diff artifact for step "${options.step}"` : "run has no diff artifact to apply");
    }
    const patchPath = rebasePath(artifact.path, run.source_root, root);
    if (!existsSync(patchPath)) throw new Error(`diff artifact is missing: ${patchPath}`);
    const patch = readFileSync(patchPath, "utf8");
    if (!patch.trim()) throw new Error(`diff artifact is empty: ${patchPath}`);

    const runDir = join(root, ".mesh", "runs", run.id);
    const files = patchFiles(patch);
    let mode: ApplyResult["mode"];
    let fileToApply = patchPath;

    if (isGitRepo(root) && hasGitHead(root)) {
      mode = "git";
      const check = git(["apply", "--check", "--whitespace=nowarn", patchPath], root);
      if (check.status !== 0) {
        throw new Error(`patch does not apply cleanly:\n${(check.stderr || check.stdout).trim()}`);
      }
      if (!options.check) {
        const applied = git(["apply", "--whitespace=nowarn", patchPath], root);
        if (applied.status !== 0) {
          throw new Error(`git apply failed:\n${(applied.stderr || applied.stdout).trim()}`);
        }
      }
    } else {
      mode = "patch";
      const tempDir = mkdtempSync(join(tmpdir(), "mesh-apply-"));
      fileToApply = join(tempDir, "changes.patch");
      writeFileSync(fileToApply, normalizePatch(patch, runDir), "utf8");
      const check = runCommand("patch", ["-p1", "--dry-run", "-d", root, "-i", fileToApply], root, 60_000);
      if (check.status !== 0) {
        rmSync(tempDir, { recursive: true, force: true });
        throw new Error(`patch does not apply cleanly:\n${(check.stderr || check.stdout).trim()}`);
      }
      if (!options.check) {
        const applied = runCommand("patch", ["-p1", "-d", root, "-i", fileToApply], root, 60_000);
        if (applied.status !== 0) {
          rmSync(tempDir, { recursive: true, force: true });
          throw new Error(`patch failed:\n${(applied.stderr || applied.stdout).trim()}`);
        }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }

    const applied = !options.check;
    if (applied) {
      db.addEvent(run.id, null, "run.applied", { patch: patchPath, files, mode, at: nowIso() });
    }
    return { runId: run.id, patchPath, mode, files, applied };
  } finally {
    db.close();
  }
}
