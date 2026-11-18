import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgent } from "./adapters.ts";
import {
  buildInvocation,
  dryRunConfig,
  getAgent,
  getWorkflow,
  interpolate,
  loadConfig,
  orderSteps,
  readStepPrompt,
} from "./config.ts";
import { MeshDb } from "./db.ts";
import type { AgentEvent, RunOptions, RunRecord, StepRecord } from "./types.ts";
import {
  ensureDir,
  git,
  hasGitHead,
  isGitRepo,
  newId,
  nowIso,
  runCommand,
  truncate,
  copyTree,
  writeText,
} from "./util.ts";

const DIFF_LIMIT = 80_000;

export interface RunResult {
  runId: string;
  runDir: string;
  status: "completed" | "failed";
  steps: Array<{ id: string; agent: string; status: string; exitCode: number }>;
}

interface PreparedWorkspace {
  path: string;
  mode: "git" | "copy";
  baseline?: string;
  initialHead?: string;
}

function prepareWorkspace(source: string, runDir: string): PreparedWorkspace {
  const target = join(runDir, "workspace");
  if (existsSync(target)) {
    const mode = existsSync(join(target, ".git")) ? "git" : "copy";
    return { path: target, mode, baseline: join(runDir, "baseline") };
  }
  if (isGitRepo(source) && hasGitHead(source)) {
    const added = git(["worktree", "add", "--detach", target, "HEAD"], source);
    if (added.status === 0) {
      const head = git(["rev-parse", "HEAD"], source);
      return { path: target, mode: "git", initialHead: head.stdout.trim() };
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  ensureDir(target);
  copyTree(source, target);
  const baseline = join(runDir, "baseline");
  if (!existsSync(baseline)) copyTree(target, baseline);
  return { path: target, mode: "copy", baseline };
}

function collectDiff(prepared: PreparedWorkspace): string {
  if (prepared.mode === "git") {
    git(["add", "-A"], prepared.path);
    const base = prepared.initialHead || "HEAD";
    const diff = git(["diff", "--cached", base], prepared.path);
    return truncate(diff.stdout, DIFF_LIMIT);
  }
  if (!prepared.baseline) return "";
  const diff = runCommand("diff", ["-ruN", prepared.baseline, prepared.path], prepared.path, 60_000);
  return truncate(diff.stdout, DIFF_LIMIT);
}

function appendEvent(runDir: string, runId: string, stepId: string, event: AgentEvent): void {
  appendFileSync(
    join(runDir, "events.ndjson"),
    `${JSON.stringify({ run_id: runId, step_id: stepId, ...event })}\n`,
    "utf8",
  );
}

export async function startRun(options: RunOptions): Promise<RunResult> {
  const workspace = resolve(options.workspace);
  const baseConfig = loadConfig(workspace);
  const config = options.dryRun ? dryRunConfig(baseConfig) : baseConfig;
  const workflow = getWorkflow(config, options.workflow);
  const steps = orderSteps(workflow);
  const runId = options.runId ?? newId("run");
  const runDir = join(workspace, ".mesh", "runs", runId);
  ensureDir(runDir);
  ensureDir(join(runDir, "prompts"));
  ensureDir(join(runDir, "steps"));
  ensureDir(join(runDir, "artifacts"));

  const prepared = prepareWorkspace(workspace, runDir);
  const db = new MeshDb(workspace);
  const existing = db.getRun(runId);
  const createdAt = existing?.created_at ?? nowIso();
  const run: RunRecord = {
    id: runId,
    goal: options.goal,
    workflow: options.workflow,
    status: "running",
    source_root: workspace,
    workspace: prepared.path,
    created_at: createdAt,
    updated_at: nowIso(),
  };
  db.upsertRun(run);
  db.addEvent(runId, null, "run.started", { goal: options.goal, workflow: options.workflow, workspace: prepared.path });
  writeText(join(runDir, "brief.md"), `# ${options.goal}\n\nWorkflow: ${options.workflow}\nRun: ${runId}\nWorkspace: ${prepared.path}\n`);

  if (!options.quiet && !options.json) {
    console.log(`\nMesh run ${runId}`);
    console.log(`  goal:     ${options.goal}`);
    console.log(`  workflow: ${options.workflow}`);
    console.log(`  workspace:${prepared.path}`);
  }

  const resultSteps: RunResult["steps"] = [];
  let diff = "";
  let failed = false;

  for (const step of steps) {
    const agent = getAgent(config, step.agent);
    const stepId = `${runId}:${step.id}`;
    const stepRecord: StepRecord = {
      id: stepId,
      run_id: runId,
      name: step.id,
      agent: step.agent,
      status: "running",
      prompt: null,
      output: null,
      error: null,
      started_at: nowIso(),
      finished_at: null,
    };
    db.upsertStep(stepRecord);
    db.addEvent(runId, step.id, "step.started", { agent: step.agent });

    const prompt = interpolate(readStepPrompt(workspace, step), {
      goal: options.goal,
      workspace: prepared.path,
      run_id: runId,
      step_id: step.id,
      diff,
      source_root: workspace,
    });
    writeText(join(runDir, "prompts", `${step.id}.md`), prompt);
    db.upsertStep({ ...stepRecord, prompt });

    if (!options.quiet && !options.json) {
      console.log(`\n▶ ${step.id}  [${step.agent}]`);
    }

    let invocation;
    try {
      invocation = buildInvocation(step.agent, agent, prompt, prepared.path, {
        goal: options.goal,
        workspace: prepared.path,
        run_id: runId,
        step_id: step.id,
        diff,
        source_root: workspace,
      });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      db.upsertStep({ ...stepRecord, status: "failed", error: message, finished_at: nowIso() });
      db.updateRunStatus(runId, "failed");
      db.close();
      throw error;
    }

    const agentResult = await runAgent({
      invocation,
      workspace: prepared.path,
      onEvent: (event) => {
        appendEvent(runDir, runId, step.id, event);
        db.addEvent(runId, step.id, event.type, { text: event.text, raw: event.raw });
        if (options.verbose && event.text && !options.quiet && !options.json) {
          process.stdout.write(`${event.text}\n`);
        }
      },
    });

    const outputPath = join(runDir, "steps", `${step.id}.md`);
    const errorText = agentResult.timedOut
      ? "Agent timed out."
      : agentResult.exitCode === 0
        ? ""
        : agentResult.stderr.trim() || `Agent exited with ${agentResult.exitCode}.`;
    writeText(
      outputPath,
      `# ${step.id}\n\nAgent: ${step.agent}\nExit: ${agentResult.exitCode}\n\n${errorText ? `## Error\n\n${errorText}\n\n` : ""}## Output\n\n${agentResult.finalText}\n`,
    );
    db.addArtifact(runId, step.id, outputPath, "step-output");

    diff = collectDiff(prepared);
    if (diff) {
      const diffPath = join(runDir, "artifacts", `diff-${step.id}.patch`);
      writeFileSync(diffPath, diff, "utf8");
      db.addArtifact(runId, step.id, diffPath, "diff");
    }

    const ok = agentResult.exitCode === 0 && !agentResult.timedOut;
    const status = ok ? "completed" : "failed";
    db.upsertStep({
      ...stepRecord,
      status,
      output: agentResult.finalText,
      error: agentResult.timedOut
        ? "agent timed out"
        : agentResult.exitCode === 0
          ? null
          : agentResult.stderr || `agent exited with ${agentResult.exitCode}`,
      finished_at: nowIso(),
    });
    db.addEvent(runId, step.id, ok ? "step.completed" : "step.failed", {
      exitCode: agentResult.exitCode,
      timedOut: agentResult.timedOut,
      stderr: agentResult.stderr.slice(0, 4_000),
    });
    resultSteps.push({ id: step.id, agent: step.agent, status, exitCode: agentResult.exitCode });

    if (!options.quiet && !options.json) {
      console.log(`  ${ok ? "✓" : "✗"} ${step.id} exited ${agentResult.exitCode}${agentResult.timedOut ? " (timeout)" : ""}`);
      if (!ok && errorText) console.log(`    ${errorText.split("\n")[0]}`);
    }
    if (!ok) {
      failed = true;
      break;
    }
  }

  const status = failed ? "failed" : "completed";
  db.updateRunStatus(runId, status);
  db.addEvent(runId, null, "run.finished", { status });
  db.close();

  if (!options.quiet && !options.json) {
    console.log(`\n${failed ? "Failed" : "Completed"}: ${runId}`);
    console.log(`  artifacts: ${join(runDir, "artifacts")}`);
  }

  return { runId, runDir, status, steps: resultSteps };
}

export function showStatus(workspace: string, runId?: string): void {
  const db = new MeshDb(workspace);
  try {
    if (runId) {
      const run = db.getRun(runId);
      if (!run) {
        console.error(`run not found: ${runId}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${run.id}  ${run.status}  ${run.workflow}`);
      console.log(`  goal: ${run.goal}`);
      console.log(`  workspace: ${run.workspace}`);
      for (const step of db.getSteps(runId)) {
        console.log(`  - ${step.name.padEnd(12)} ${step.agent.padEnd(8)} ${step.status}`);
      }
      const artifacts = db.getArtifacts(runId);
      if (artifacts.length > 0) {
        console.log("  artifacts:");
        for (const artifact of artifacts) console.log(`    ${artifact.path}`);
      }
      return;
    }
    const runs = db.listRuns();
    if (runs.length === 0) {
      console.log("no runs yet");
      return;
    }
    for (const run of runs) {
      console.log(`${run.id}  ${run.status.padEnd(10)} ${run.workflow.padEnd(22)} ${run.goal}`);
    }
  } finally {
    db.close();
  }
}

export function listAgents(workspace: string): void {
  const config = loadConfig(workspace);
  for (const [id, agent] of Object.entries(config.agents)) {
    console.log(`${id.padEnd(10)} ${agent.command}  ${agent.capabilities.join(", ")}`);
  }
}

export function readRun(workspace: string, runId: string): { run: RunRecord; steps: StepRecord[] } | null {
  const db = new MeshDb(workspace);
  try {
    const run = db.getRun(runId);
    if (!run) return null;
    return { run, steps: db.getSteps(runId) };
  } finally {
    db.close();
  }
}
