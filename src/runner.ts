import { appendFileSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { runAgent } from "./adapters.ts";
import {
  buildInvocation,
  dryRunConfig,
  getWorkflow,
  interpolate,
  loadConfig,
  orderSteps,
  readStepPrompt,
  resolveStepAgents,
} from "./config.ts";
import { MeshDb } from "./db.ts";
import type {
  AgentConfig,
  AgentEvent,
  BudgetConfig,
  MeshConfig,
  RunOptions,
  RunRecord,
  StepConfig,
  StepRecord,
  Usage,
} from "./types.ts";
import {
  copyTree,
  ensureDir,
  formatUsd,
  git,
  hasGitHead,
  isGitRepo,
  isTerminalStatus,
  newId,
  nowIso,
  processAlive,
  readText,
  rebasePath,
  runCommand,
  truncate,
  writeText,
} from "./util.ts";

const DIFF_LIMIT = 80_000;
const GIT_IDENTITY = ["-c", "user.name=Mesh", "-c", "user.email=mesh@local"];

export interface RunResult {
  runId: string;
  runDir: string;
  status: "completed" | "failed" | "cancelled";
  steps: Array<{ id: string; agent: string; status: string; exitCode: number }>;
  usage: Usage;
}

interface PreparedWorkspace {
  path: string;
  mode: "git" | "copy";
  baseline?: string;
  initialHead?: string;
}

interface StepOutcome {
  step: StepConfig;
  agent: string;
  status: "completed" | "failed" | "cancelled";
  exitCode: number;
  usage: Usage;
  error: string;
  output: string;
  branchSha?: string;
  branchDir?: string;
}

interface RunContext {
  workspace: string;
  runId: string;
  runDir: string;
  prepared: PreparedWorkspace;
  db: MeshDb;
  config: MeshConfig;
  options: RunOptions;
  budget?: BudgetConfig;
  controller: AbortController;
  totals: Usage;
  warnedUsage: boolean;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function addUsage(target: Usage, usage: Usage | undefined): void {
  if (!usage) return;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.costUsd += usage.costUsd;
}

function prepareWorkspace(source: string, runDir: string): PreparedWorkspace {
  const target = join(runDir, "workspace");
  const headFile = join(runDir, "initial-head");
  if (existsSync(target)) {
    const mode = existsSync(join(target, ".git")) ? "git" : "copy";
    const initialHead = existsSync(headFile) ? readText(headFile).trim() : undefined;
    return { path: target, mode, baseline: join(runDir, "baseline"), initialHead };
  }
  if (isGitRepo(source) && hasGitHead(source)) {
    const added = git(["worktree", "add", "--detach", target, "HEAD"], source);
    if (added.status === 0) {
      const head = git(["rev-parse", "HEAD"], source);
      const sha = head.stdout.trim();
      writeText(headFile, `${sha}\n`);
      return { path: target, mode: "git", initialHead: sha };
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  ensureDir(target);
  copyTree(source, target);
  const baseline = join(runDir, "baseline");
  if (!existsSync(baseline)) copyTree(target, baseline);
  return { path: target, mode: "copy", baseline };
}

/** Diff of a workspace against the run's initial commit (or the copy baseline). */
function collectDiff(prepared: PreparedWorkspace, runDir: string): string {
  if (prepared.mode === "git") {
    git(["add", "-A"], prepared.path);
    const base = prepared.initialHead || "HEAD";
    const diff = git(["diff", "--cached", base], prepared.path);
    return truncate(diff.stdout, DIFF_LIMIT);
  }
  if (!prepared.baseline) return "";
  const diff = runCommand("diff", ["-ruN", "baseline", "workspace"], runDir, 60_000);
  return truncate(diff.stdout, DIFF_LIMIT);
}

function appendEvent(runDir: string, runId: string, stepId: string, event: AgentEvent): void {
  appendFileSync(
    join(runDir, "events.ndjson"),
    `${JSON.stringify({ run_id: runId, step_id: stepId, ...event })}\n`,
    "utf8",
  );
}

function latestDiff(db: MeshDb, run: RunRecord, workspace: string): string {
  const artifacts = db.getArtifacts(run.id).filter((artifact) => artifact.kind === "diff");
  const latest = artifacts.at(-1);
  if (!latest) return "";
  const path = rebasePath(latest.path, run.source_root, workspace);
  try {
    return truncate(readText(path), DIFF_LIMIT);
  } catch {
    return "";
  }
}

function writeDiffArtifact(ctx: RunContext, stepId: string, diff: string, name?: string): void {
  if (!diff) return;
  const path = join(ctx.runDir, "artifacts", name ?? `diff-${stepId}.patch`);
  writeFileSync(path, diff, "utf8");
  ctx.db.addArtifact(ctx.runId, stepId, path, "diff");
}

function budgetViolation(totals: Usage, budget?: BudgetConfig): string | null {
  if (!budget) return null;
  if (budget.maxCostUsd !== undefined && totals.costUsd > budget.maxCostUsd) {
    return `budget exceeded: cost ${formatUsd(totals.costUsd)} > maxCostUsd ${formatUsd(budget.maxCostUsd)}`;
  }
  if (budget.maxInputTokens !== undefined && totals.inputTokens > budget.maxInputTokens) {
    return `budget exceeded: ${totals.inputTokens} input tokens > maxInputTokens ${budget.maxInputTokens}`;
  }
  if (budget.maxOutputTokens !== undefined && totals.outputTokens > budget.maxOutputTokens) {
    return `budget exceeded: ${totals.outputTokens} output tokens > maxOutputTokens ${budget.maxOutputTokens}`;
  }
  return null;
}

async function requestApproval(step: StepConfig, ctx: RunContext): Promise<"approved" | "denied" | "unavailable"> {
  if (!step.approve || ctx.options.yes || ctx.options.dryRun) return "approved";
  if (!process.stdin.isTTY) return "unavailable";
  process.stdout.write(
    `\n⚠  step "${step.id}" (${step.capability ?? step.agent}) is marked for approval. Run it? [y/N] `,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((done) => rl.question("", done));
    return /^y(es)?$/i.test(answer.trim()) ? "approved" : "denied";
  } finally {
    rl.close();
  }
}

function markStepCancelled(ctx: RunContext, step: StepConfig, reason: string): void {
  const stepId = `${ctx.runId}:${step.id}`;
  const existing = ctx.db.getSteps(ctx.runId).find((record) => record.id === stepId);
  ctx.db.upsertStep({
    id: stepId,
    run_id: ctx.runId,
    name: step.id,
    agent: existing?.agent ?? step.capability ?? step.agent ?? "unknown",
    status: "cancelled",
    prompt: existing?.prompt ?? null,
    output: existing?.output ?? null,
    error: reason,
    started_at: existing?.started_at ?? nowIso(),
    finished_at: nowIso(),
    usage: existing?.usage ?? null,
    attempt: existing?.attempt ?? 0,
  });
  ctx.db.addEvent(ctx.runId, step.id, "step.cancelled", { reason });
}

/**
 * Run one step in one workspace. Approval must be checked by the caller.
 * Handles capability routing, spawn fallback, retries, usage and artifacts.
 */
async function runStep(ctx: RunContext, step: StepConfig, workspacePath: string, diff: string): Promise<StepOutcome> {
  const { db, runId, runDir, options, config } = ctx;
  const stepId = `${runId}:${step.id}`;
  const candidates = resolveStepAgents(config, step);
  const previous = db
    .getSteps(runId)
    .filter((record) => record.name !== step.id && record.status === "completed" && record.output)
    .map((record) => `### ${record.name} (${record.agent})\n${truncate(record.output ?? "", 8_000)}`)
    .join("\n\n");
  const promptVars = {
    goal: options.goal,
    workspace: workspacePath,
    run_id: runId,
    step_id: step.id,
    diff,
    previous,
    source_root: ctx.workspace,
  };
  const prompt = interpolate(readStepPrompt(ctx.workspace, step), promptVars);
  writeText(join(runDir, "prompts", `${step.id}.md`), prompt);

  const stepRecord: StepRecord = {
    id: stepId,
    run_id: runId,
    name: step.id,
    agent: candidates[0],
    status: "running",
    prompt,
    output: null,
    error: null,
    started_at: nowIso(),
    finished_at: null,
    usage: null,
    attempt: 0,
  };
  db.upsertStep(stepRecord);
  db.addEvent(runId, step.id, "step.started", { agent: candidates[0], candidates });

  if (!options.quiet && !options.json) {
    console.log(`\n▶ ${step.id}  [${candidates[0]}]`);
  }

  const maxAttempts = Math.max(0, options.retry ?? 0) + 1;
  let attempt = 0;
  let usedAgent = candidates[0];
  let result = null as Awaited<ReturnType<typeof runAgent>> | null;
  let stop = false;

  for (let index = 0; index < candidates.length && !stop; index += 1) {
    const agentId = candidates[index];
    const agent: AgentConfig = config.agents[agentId];
    usedAgent = agentId;
    for (let tries = 0; tries < maxAttempts; tries += 1) {
      attempt += 1;
      db.upsertStep({ ...stepRecord, agent: agentId, attempt });
      let invocation;
      try {
        invocation = buildInvocation(agentId, agent, prompt, workspacePath, promptVars);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        db.upsertStep({ ...stepRecord, agent: agentId, status: "failed", error: message, finished_at: nowIso(), attempt });
        db.addEvent(runId, step.id, "step.failed", { error: message });
        return {
          step,
          agent: agentId,
          status: "failed",
          exitCode: 1,
          usage: emptyUsage(),
          error: message,
          output: "",
        };
      }

      if (options.verbose && !options.quiet && !options.json) {
        process.stdout.write(`  ${agentId}> ${invocation.command} ${invocation.args.join(" ")}\n`);
      }
      const agentResult = await runAgent({
        invocation,
        workspace: workspacePath,
        signal: ctx.controller.signal,
        onEvent: (event) => {
          appendEvent(runDir, runId, step.id, event);
          db.addEvent(runId, step.id, event.type, { text: event.text, raw: event.raw });
          if (options.verbose && event.text && !options.quiet && !options.json) {
            process.stdout.write(`${event.text}\n`);
          }
        },
      });
      result = agentResult;
      db.addEvent(runId, step.id, "step.attempt", { agent: agentId, attempt, exitCode: agentResult.exitCode });

      if (agentResult.cancelled || ctx.controller.signal.aborted) {
        stop = true;
        break;
      }
      if (agentResult.spawnError && index < candidates.length - 1) {
        db.addEvent(runId, step.id, "step.fallback", {
          from: agentId,
          to: candidates[index + 1],
          error: agentResult.stderr.slice(0, 500),
        });
        stop = false;
        break;
      }
      if (agentResult.exitCode === 0 && !agentResult.timedOut) {
        stop = true;
        break;
      }
      if (agentResult.spawnError) {
        stop = true;
        break;
      }
      if (tries < maxAttempts - 1) {
        db.addEvent(runId, step.id, "step.retry", { attempt: attempt + 1, exitCode: agentResult.exitCode });
      }
    }
    if (!stop && result && !result.spawnError && result.exitCode !== 0) stop = true;
    if (stop) break;
  }

  if (!result) {
    result = {
      exitCode: 127,
      finalText: "",
      events: [],
      stdout: "",
      stderr: "no agent candidates",
      timedOut: false,
      spawnError: true,
    };
  }

  const usage = result.usage ?? emptyUsage();
  addUsage(ctx.totals, usage);
  if (usage.inputTokens + usage.outputTokens + usage.costUsd > 0) {
    db.addRunUsage(runId, usage);
  } else if (!ctx.warnedUsage && ctx.budget) {
    ctx.warnedUsage = true;
    db.addEvent(runId, step.id, "run.warning", {
      message: "agent reported no token usage; budget checks cannot see this step's cost",
    });
  }

  const outputPath = join(runDir, "steps", `${step.id}.md`);
  const cancelled = result.cancelled || ctx.controller.signal.aborted;
  const errorText = cancelled
    ? "Agent cancelled."
    : result.timedOut
      ? "Agent timed out."
      : result.exitCode === 0
        ? ""
        : result.stderr.trim() || `Agent exited with ${result.exitCode}.`;
  const status: StepOutcome["status"] = cancelled ? "cancelled" : result.exitCode === 0 && !result.timedOut ? "completed" : "failed";
  writeText(
    outputPath,
    `# ${step.id}\n\nAgent: ${usedAgent}\nExit: ${result.exitCode}${cancelled ? " (cancelled)" : ""}\n\n${
      errorText ? `## Error\n\n${errorText}\n\n` : ""
    }## Output\n\n${result.finalText}\n`,
  );
  db.addArtifact(runId, step.id, outputPath, "step-output");

  db.upsertStep({
    ...stepRecord,
    agent: usedAgent,
    status,
    output: result.finalText,
    error: cancelled ? "cancelled" : result.timedOut ? "agent timed out" : result.exitCode === 0 ? null : result.stderr || `agent exited with ${result.exitCode}`,
    finished_at: nowIso(),
    usage: JSON.stringify(usage),
    attempt,
  });
  db.addEvent(runId, step.id, cancelled ? "step.cancelled" : status === "completed" ? "step.completed" : "step.failed", {
    agent: usedAgent,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    usage,
    stderr: result.stderr.slice(0, 4_000),
  });

  if (!options.quiet && !options.json) {
    console.log(
      `  ${status === "completed" ? "✓" : status === "cancelled" ? "■" : "✗"} ${step.id} [${usedAgent}] exited ${result.exitCode}${
        result.timedOut ? " (timeout)" : cancelled ? " (cancelled)" : ""
      }${usage.costUsd > 0 ? ` · ${formatUsd(usage.costUsd)}` : ""}`,
    );
    if (status === "failed" && errorText) console.log(`    ${errorText.split("\n")[0]}`);
  }

  return {
    step,
    agent: usedAgent,
    status,
    exitCode: result.exitCode,
    usage,
    error: errorText,
    output: result.finalText,
    branchDir: undefined,
  };
}

function checkpoint(workspacePath: string): string {
  git(["add", "-A"], workspacePath);
  git([...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "mesh: checkpoint"], workspacePath);
  return git(["rev-parse", "HEAD"], workspacePath).stdout.trim();
}

function commitBranch(branchPath: string, message: string): string {
  git(["add", "-A"], branchPath);
  git([...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", message], branchPath);
  return git(["rev-parse", "HEAD"], branchPath).stdout.trim();
}

interface BatchResult {
  completed: string[];
  failed: boolean;
  cancelled: boolean;
  diff: string;
  steps: RunResult["steps"];
}

/**
 * Run independent steps in per-step git worktrees and merge each branch back
 * into the run workspace. Branches are created from a checkpoint commit, so
 * the merge is a normal three-way git merge instead of a file copy.
 */
async function runParallelBatch(ctx: RunContext, ready: StepConfig[], diff: string): Promise<BatchResult> {
  for (const step of ready) {
    const approval = await requestApproval(step, ctx);
    if (approval !== "approved") {
      const reason = approval === "denied" ? "approval declined" : "approval required; rerun with --yes";
      markStepCancelled(ctx, step, reason);
      return { completed: [], failed: false, cancelled: true, diff, steps: [] };
    }
  }
  const base = checkpoint(ctx.prepared.path);
  const branchResults = await Promise.all(
    ready.map(async (step) => {
      const branchDir = join(ctx.runDir, "branches", step.id);
      rmSync(branchDir, { recursive: true, force: true });
      const added = git(["worktree", "add", "--detach", branchDir, base], ctx.prepared.path);
      if (added.status !== 0) {
        ctx.db.addEvent(ctx.runId, step.id, "step.failed", { error: `worktree add failed: ${added.stderr}` });
        return { step, outcome: null as StepOutcome | null, denied: null };
      }
      const outcome = await runStep(ctx, step, branchDir, diff);
      outcome.branchDir = branchDir;
      if (outcome.status === "completed") {
        git(["add", "-A"], branchDir);
        const branchDiff = git(["diff", "--cached", base], branchDir);
        writeDiffArtifact(ctx, step.id, truncate(branchDiff.stdout, DIFF_LIMIT));
        outcome.branchSha = commitBranch(branchDir, `mesh: ${step.id}`);
      }
      return { step, outcome, denied: null };
    }),
  );

  const completed: string[] = [];
  const stepResults: RunResult["steps"] = [];
  let failed = false;
  let cancelled = false;
  let mergedDiff = diff;

  for (const entry of branchResults) {
    if (entry.outcome == null) {
      failed = true;
      continue;
    }
    const outcome = entry.outcome;
    const record = {
      id: outcome.step.id,
      agent: outcome.agent,
      status: outcome.status,
      exitCode: outcome.exitCode,
    };
    stepResults.push(record);
    if (outcome.status === "cancelled") {
      cancelled = true;
      continue;
    }
    if (outcome.status === "failed") {
      failed = true;
      continue;
    }
    if (!outcome.branchSha) {
      failed = true;
      continue;
    }
    const merge = git(
      [...GIT_IDENTITY, "merge", "--no-ff", "-q", "-m", `mesh: merge ${outcome.step.id}`, outcome.branchSha],
      ctx.prepared.path,
    );
    if (merge.status !== 0) {
      git(["merge", "--abort"], ctx.prepared.path);
      const message = `merge conflict while integrating step "${outcome.step.id}"; branch kept at ${outcome.branchDir}`;
      const stepId = `${ctx.runId}:${outcome.step.id}`;
      const record = ctx.db.getSteps(ctx.runId).find((item) => item.id === stepId);
      if (record) {
        ctx.db.upsertStep({ ...record, status: "failed", error: message, finished_at: nowIso() });
      }
      ctx.db.addEvent(ctx.runId, outcome.step.id, "step.failed", { error: message, merge: merge.stderr.slice(0, 2_000) });
      failed = true;
      continue;
    }
    completed.push(outcome.step.id);
    mergedDiff = collectDiff(ctx.prepared, ctx.runDir);
    writeDiffArtifact(ctx, outcome.step.id, mergedDiff, `diff-merged-${outcome.step.id}.patch`);
    if (outcome.branchDir) {
      git(["worktree", "remove", "--force", outcome.branchDir], ctx.prepared.path);
    }
  }

  return { completed, failed, cancelled, diff: mergedDiff, steps: stepResults };
}

function pidFromFile(path: string): number | null {
  try {
    const pid = Number(readText(path).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function recoverStaleRuns(workspace: string, provided?: MeshDb): number {
  const db = provided ?? new MeshDb(workspace);
  const own = !provided;
  try {
    let changed = 0;
    for (const run of db.listRuns(500)) {
      if (run.status !== "running" && run.status !== "queued") continue;
      const runDir = join(resolve(workspace), ".mesh", "runs", run.id);
      const pid = pidFromFile(join(runDir, "pid")) ?? (run.pid ? Number(run.pid) : null);
      if (pid && processAlive(pid)) continue;
      if (!pid) {
        const age = Date.now() - Date.parse(run.updated_at);
        if (Number.isFinite(age) && age < 10 * 60_000) continue;
      }
      db.updateRunStatus(run.id, "cancelled", { clearPid: true });
      for (const step of db.getSteps(run.id)) {
        if (step.status === "running") {
          db.upsertStep({ ...step, status: "cancelled", error: "interrupted", finished_at: nowIso() });
        }
      }
      db.addEvent(run.id, null, "run.recovered", {
        status: "cancelled",
        reason: pid ? `process ${pid} is no longer alive` : "run was never picked up",
      });
      changed += 1;
    }
    return changed;
  } finally {
    if (own) db.close();
  }
}

export function cancelRun(workspace: string, runId: string): { runId: string; status: string; message: string } {
  const db = new MeshDb(workspace);
  try {
    const run = db.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (isTerminalStatus(run.status)) {
      return { runId, status: run.status, message: `run is already ${run.status}` };
    }
    const runDir = join(resolve(workspace), ".mesh", "runs", runId);
    ensureDir(runDir);
    writeFileSync(join(runDir, "CANCEL"), `${nowIso()}\n`, "utf8");
    const pid = pidFromFile(join(runDir, "pid")) ?? (run.pid ? Number(run.pid) : null);
    if (pid && !processAlive(pid)) {
      db.updateRunStatus(runId, "cancelled", { clearPid: true });
      for (const step of db.getSteps(runId)) {
        if (step.status === "running") {
          db.upsertStep({ ...step, status: "cancelled", error: "cancelled", finished_at: nowIso() });
        }
      }
      db.addEvent(runId, null, "run.cancelled", { reason: "runner process was not alive" });
      return { runId, status: "cancelled", message: "runner was not alive; run marked cancelled" };
    }
    db.addEvent(runId, null, "run.cancel_requested", {});
    return { runId, status: "running", message: "cancel requested" };
  } finally {
    db.close();
  }
}

async function notify(url: string | undefined, payload: Record<string, unknown>): Promise<void> {
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    console.warn(`mesh: ignoring notify webhook (only http/https is supported): ${url}`);
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) console.warn(`mesh: notify webhook returned ${response.status}`);
  } catch (error) {
    console.warn(`mesh: notify webhook failed: ${String(error instanceof Error ? error.message : error)}`);
  }
}

export async function startRun(options: RunOptions): Promise<RunResult> {
  const workspace = resolve(options.workspace);
  const baseConfig = loadConfig(workspace);
  const config = options.dryRun ? dryRunConfig(baseConfig) : baseConfig;
  const runId = options.runId ?? newId("run");
  const runDir = join(workspace, ".mesh", "runs", runId);
  ensureDir(runDir);
  ensureDir(join(runDir, "prompts"));
  ensureDir(join(runDir, "steps"));
  ensureDir(join(runDir, "artifacts"));

  const db = new MeshDb(workspace);
  recoverStaleRuns(workspace, db);
  const existing = db.getRun(runId);

  if (existing && (existing.status === "running" || existing.status === "queued")) {
    const pid = pidFromFile(join(runDir, "pid")) ?? (existing.pid ? Number(existing.pid) : null);
    if (pid && processAlive(pid)) {
      db.close();
      throw new Error(`run ${runId} is still running (pid ${pid}); cancel it with "mesh cancel ${runId}" first`);
    }
    if (existing.status === "running") {
      db.updateRunStatus(runId, "cancelled", { clearPid: true });
    }
  }

  const cancelMarker = join(runDir, "CANCEL");
  if (existsSync(cancelMarker) && existing && !options.resume) {
    db.updateRunStatus(runId, "cancelled", { clearPid: true });
    db.addEvent(runId, null, "run.cancelled", { reason: "cancel requested before the run started" });
    db.close();
    return { runId, runDir, status: "cancelled", steps: [], usage: emptyUsage() };
  }

  const goal = (options.goal || existing?.goal || "").trim();
  if (!goal) {
    db.close();
    throw new Error("missing goal");
  }
  const workflowName =
    options.workflowExplicit || !existing ? options.workflow : existing.workflow;
  const workflow = getWorkflow(config, workflowName);
  const steps = orderSteps(workflow);
  const prepared = prepareWorkspace(workspace, runDir);

  const createdAt = existing?.created_at ?? nowIso();
  const run: RunRecord = {
    id: runId,
    goal,
    workflow: workflowName,
    status: "running",
    source_root: workspace,
    workspace: prepared.path,
    created_at: createdAt,
    updated_at: nowIso(),
    pid: String(process.pid),
  };
  db.upsertRun(run);
  db.setRunPid(runId, process.pid);
  writeText(join(runDir, "pid"), `${process.pid}\n`);
  rmSync(cancelMarker, { force: true });
  db.addEvent(runId, null, "run.started", {
    goal,
    workflow: workflowName,
    workspace: prepared.path,
    resumed: existing != null,
  });
  writeText(join(runDir, "brief.md"), `# ${goal}\n\nWorkflow: ${workflowName}\nRun: ${runId}\nWorkspace: ${prepared.path}\n`);

  if (!options.quiet && !options.json) {
    console.log(`\nMesh run ${runId}${existing ? " (resume)" : ""}`);
    console.log(`  goal:     ${goal}`);
    console.log(`  workflow: ${workflowName}`);
    console.log(`  workspace:${prepared.path}`);
  }

  const controller = new AbortController();
  let signalCount = 0;
  const onSignal = () => {
    signalCount += 1;
    if (signalCount > 1) process.exit(130);
    if (!options.quiet && !options.json) console.log("\n  cancel requested; stopping the current agent…");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const cancelPoll = setInterval(() => {
    if (existsSync(join(runDir, "CANCEL"))) controller.abort();
  }, 500);
  cancelPoll.unref();

  const reuseCompleted = existing != null && existing.workflow === workflowName;
  const priorSteps = reuseCompleted ? db.getSteps(runId) : [];
  const completedBefore = new Map(priorSteps.filter((step) => step.status === "completed").map((step) => [step.name, step]));

  const ctx: RunContext = {
    workspace,
    runId,
    runDir,
    prepared,
    db,
    config,
    options: { ...options, goal },
    budget: {
      ...baseConfig.budget,
      ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
    },
    controller,
    totals: {
      inputTokens: existing?.input_tokens ?? 0,
      outputTokens: existing?.output_tokens ?? 0,
      costUsd: existing?.total_cost_usd ?? 0,
    },
    warnedUsage: false,
  };

  const resultSteps: RunResult["steps"] = [];
  const done = new Set<string>();
  for (const step of steps) {
    const prior = completedBefore.get(step.id);
    if (prior) {
      done.add(step.id);
      resultSteps.push({ id: step.id, agent: prior.agent, status: "skipped", exitCode: 0 });
      db.addEvent(runId, step.id, "step.reused", { agent: prior.agent });
    }
  }

  let diff = latestDiff(db, run, workspace);
  let failed = false;
  let cancelled = false;
  let failureMessage = "";

  try {
    while (done.size < steps.length) {
      if (controller.signal.aborted) {
        cancelled = true;
        break;
      }
      const ready = steps.filter(
        (step) => !done.has(step.id) && (step.needs ?? []).every((need) => done.has(need)),
      );
      if (ready.length === 0) {
        failureMessage = "workflow dependency cycle while scheduling steps";
        failed = true;
        break;
      }

      const violation = budgetViolation(ctx.totals, ctx.budget);
      if (violation) {
        failureMessage = violation;
        failed = true;
        db.addEvent(runId, null, "run.budget_exceeded", { reason: violation, usage: ctx.totals });
        break;
      }

      if (ready.length > 1 && prepared.mode === "git") {
        const batch = await runParallelBatch(ctx, ready, diff);
        diff = batch.diff;
        resultSteps.push(...batch.steps);
        for (const id of batch.completed) done.add(id);
        if (batch.cancelled) {
          cancelled = true;
          break;
        }
        if (batch.failed) {
          failed = true;
          break;
        }
        continue;
      }

      if (ready.length > 1) {
        db.addEvent(runId, null, "run.warning", {
          message: "independent steps run serially because the workspace is not a git repository",
        });
      }

      const step = ready[0];
      const approval = await requestApproval(step, ctx);
      if (approval !== "approved") {
        markStepCancelled(ctx, step, approval === "denied" ? "approval declined" : "approval required; rerun with --yes");
        cancelled = true;
        break;
      }

      const outcome = await runStep(ctx, step, prepared.path, diff);
      resultSteps.push({ id: step.id, agent: outcome.agent, status: outcome.status, exitCode: outcome.exitCode });
      if (outcome.status === "cancelled") {
        cancelled = true;
        break;
      }
      if (outcome.status === "failed") {
        failed = true;
        break;
      }
      done.add(step.id);
      diff = collectDiff(prepared, runDir);
      writeDiffArtifact(ctx, step.id, diff);

      const violationAfter = budgetViolation(ctx.totals, ctx.budget);
      if (violationAfter) {
        failureMessage = violationAfter;
        failed = true;
        db.addEvent(runId, null, "run.budget_exceeded", { reason: violationAfter, usage: ctx.totals });
        break;
      }
    }
  } finally {
    clearInterval(cancelPoll);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    try {
      rmSync(join(runDir, "pid"), { force: true });
    } catch {
      // Ignore: the pid file is advisory.
    }
  }

  const status: RunResult["status"] = cancelled ? "cancelled" : failed ? "failed" : "completed";
  if (failureMessage) db.addEvent(runId, null, "run.error", { message: failureMessage });
  db.updateRunStatus(runId, status, { clearPid: true });
  db.addEvent(runId, null, "run.finished", { status, usage: ctx.totals });

  const summaryPath = join(runDir, "summary.md");
  writeText(
    summaryPath,
    [
      `# ${goal}`,
      "",
      `- Run: ${runId}`,
      `- Workflow: ${workflowName}`,
      `- Status: ${status}`,
      `- Steps: ${resultSteps.map((step) => `${step.id}=${step.status}`).join(", ") || "none"}`,
      `- Tokens: ${ctx.totals.inputTokens} in / ${ctx.totals.outputTokens} out`,
      `- Cost: ${formatUsd(ctx.totals.costUsd)}`,
      ...(failureMessage ? ["", `## Error`, "", failureMessage] : []),
      "",
    ].join("\n"),
  );
  db.addArtifact(runId, null, summaryPath, "summary");
  db.close();

  await notify(options.notify ?? baseConfig.notify?.webhook, {
    event: "run.finished",
    run_id: runId,
    status,
    goal,
    workflow: workflowName,
    workspace,
    usage: ctx.totals,
    error: failureMessage || null,
  });

  if (!options.quiet && !options.json) {
    console.log(`\n${status === "completed" ? "Completed" : status === "cancelled" ? "Cancelled" : "Failed"}: ${runId}`);
    if (failureMessage) console.log(`  ${failureMessage}`);
    console.log(`  artifacts: ${join(runDir, "artifacts")}`);
    if (ctx.totals.costUsd > 0 || ctx.totals.inputTokens > 0) {
      console.log(
        `  usage: ${ctx.totals.inputTokens} in / ${ctx.totals.outputTokens} out tokens · ${formatUsd(ctx.totals.costUsd)}`,
      );
    }
  }

  return { runId, runDir, status, steps: resultSteps, usage: ctx.totals };
}

export function showStatus(workspace: string, runId?: string): void {
  const db = new MeshDb(workspace);
  try {
    recoverStaleRuns(workspace, db);
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
      const cost = run.total_cost_usd ?? 0;
      const input = run.input_tokens ?? 0;
      const output = run.output_tokens ?? 0;
      if (cost > 0 || input > 0) {
        console.log(`  usage: ${input} in / ${output} out tokens · ${formatUsd(cost)}`);
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
