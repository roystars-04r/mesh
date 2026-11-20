#!/usr/bin/env node
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyRun } from "./apply.ts";
import { configPath, packageRoot } from "./config.ts";
import { doctor, printDoctor } from "./doctor.ts";
import { cleanRuns } from "./maintenance.ts";
import { runMcpServer } from "./mcp.ts";
import { cancelRun, listAgents, showStatus, startRun } from "./runner.ts";
import { computeStats } from "./stats.ts";
import { startWebServer } from "./web.ts";
import type { RunOptions } from "./types.ts";
import { formatDuration, formatUsd } from "./util.ts";

const VERSION = "0.2.0";

function usage(): void {
  console.log(`mesh ${VERSION} — local multi-agent orchestration

Usage:
  mesh doctor                         Check Node, git, config, and agent CLIs
  mesh agents                         List configured agents and capabilities
  mesh run <goal> [options]           Run a workflow on a goal
  mesh retry <run_id> [options]       Rerun failed steps of a run, reusing successes
  mesh cancel <run_id>                Cancel a running or queued run
  mesh apply <run_id> [--step id]     Apply a run's diff to the workspace
  mesh status [run_id]                Show a run or recent runs
  mesh logs <run_id> [--step id]      Print a run's event log
  mesh stats [--json]                 Aggregate counts, cost, and durations
  mesh clean [options]                Delete old runs and pruned worktrees
  mesh mcp                            Start the MCP server on stdio
  mesh web [options]                  Open the local dashboard
  mesh init                           Create mesh.json and prompts/ if missing

Run options:
  --workflow <name>    Workflow from mesh.json (default: implement-review)
  --workspace <path>   Workspace to operate on (default: current directory)
  --run-id <id>        Continue an existing run id (used by the MCP server and web UI)
  --resume             With --run-id: reuse completed steps instead of rerunning them
  --retry <n>          Retry each failed step up to n times (default: 0)
  --max-cost <usd>     Stop before the next step when the run exceeds this cost
  --yes                Approve steps that require confirmation
  --notify <url>       POST a JSON summary to this webhook when the run ends
  --dry-run            Replace every agent with the local mock (no model calls)
  --verbose            Stream agent text to stdout
  --quiet              Only errors and the final summary
  --json               Print a machine-readable result

Apply options:
  --step <id>          Apply only this step's diff (default: the latest diff)
  --check              Verify the patch applies without changing files

Clean options:
  --keep <n>           Keep the newest n finished runs (default: 10)
  --all                Delete every finished run
  --dry-run            List what would be deleted
  --yes                Skip the confirmation prompt

Web options:
  --port <number>      Port to listen on (default: 4317)
  --host <address>     Bind address (default: 127.0.0.1)
  --workspace <path>   Workspace to read and start runs in (default: current directory)

Examples:
  mesh doctor
  mesh run "Add pagination to the search endpoint" --verbose
  mesh run "Review the auth changes" --workflow implement-review-verify
  mesh retry run_20260101_120000_ab12cd --retry 1
  mesh apply run_20260101_120000_ab12cd --check
  mesh stats
  mesh web
`);
}

function parseRunOptions(args: string[], requireGoal = true): RunOptions {
  const options: RunOptions = {
    goal: "",
    workflow: "implement-review",
    workspace: process.cwd(),
  };
  const goal: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workflow") {
      options.workflow = args[++index] ?? "";
      options.workflowExplicit = true;
    } else if (arg === "--workspace") {
      options.workspace = resolve(args[++index] ?? ".");
    } else if (arg === "--run-id") {
      options.runId = args[++index] ?? "";
    } else if (arg === "--resume") {
      options.resume = true;
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        options.runId = next;
        index += 1;
      }
    } else if (arg === "--retry") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 0) throw new Error("invalid --retry value");
      options.retry = value;
    } else if (arg === "--max-cost") {
      const value = Number(args[++index]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("invalid --max-cost value");
      options.maxCostUsd = value;
    } else if (arg === "--notify") {
      const value = args[++index] ?? "";
      if (!value) throw new Error("missing --notify value");
      options.notify = value;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      goal.push(arg);
    }
  }
  options.goal = goal.join(" ").trim();
  if (requireGoal && !options.goal && !options.runId) throw new Error("missing goal");
  if (!options.workflow && !options.runId) throw new Error("missing --workflow value");
  if (options.json) options.quiet = true;
  return options;
}

function parseWebOptions(args: string[]): { port: number; host: string; workspace: string } {
  let port = 4317;
  let host = "127.0.0.1";
  let workspace = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("invalid --port value");
      port = value;
    } else if (arg === "--host") {
      host = args[++index] ?? "";
      if (!host) throw new Error("missing --host value");
    } else if (arg === "--workspace") {
      workspace = resolve(args[++index] ?? ".");
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return { port, host, workspace };
}

function takeWorkspace(args: string[], fallback: string): { workspace: string; rest: string[] } {
  const rest: string[] = [];
  let workspace = fallback;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace") {
      const value = args[index + 1];
      if (!value) throw new Error("missing --workspace value");
      workspace = resolve(value);
      index += 1;
    } else if (arg.startsWith("--workspace=")) {
      workspace = resolve(arg.slice("--workspace=".length));
    } else {
      rest.push(arg);
    }
  }
  return { workspace, rest };
}

function init(workspace: string): void {
  const root = resolve(workspace);
  const target = configPath(root);
  if (existsSync(target)) {
    console.log(`mesh.json already exists: ${target}`);
  } else {
    cpSync(join(packageRoot, "mesh.json"), target);
    console.log(`created ${target}`);
  }
  const prompts = join(root, "prompts");
  if (!existsSync(prompts)) {
    cpSync(join(packageRoot, "prompts"), prompts, { recursive: true });
    console.log(`created ${prompts}`);
  }
  console.log("Next: mesh doctor");
}

function printLogs(workspace: string, runId: string, step?: string): void {
  const path = join(resolve(workspace), ".mesh", "runs", runId, "events.ndjson");
  if (!existsSync(path)) {
    throw new Error(`no events for run ${runId} at ${path}`);
  }
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.log(line);
      continue;
    }
    if (step && event.step_id !== step) continue;
    const text = event.text ? ` ${String(event.text)}` : "";
    const exit = event.exitCode !== undefined ? ` exit=${String(event.exitCode)}` : "";
    console.log(`${String(event.at ?? "")} ${String(event.step_id ?? "-")} ${String(event.type)}${exit}${text}`);
  }
}

function runCommandLine(rest: string[]): void {
  const options = parseRunOptions(rest);
  void startRun(options)
    .then((result) => {
      if (options.json) console.log(JSON.stringify(result, null, 2));
      if (result.status === "failed") process.exitCode = 1;
      if (result.status === "cancelled") process.exitCode = 130;
    })
    .catch((error) => {
      console.error(`mesh: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

function retryCommandLine(rest: string[]): void {
  const runId = rest.shift();
  if (!runId) throw new Error("usage: mesh retry <run_id> [options]");
  const options = parseRunOptions(rest, false);
  const merged: RunOptions = {
    ...options,
    goal: options.goal || runId,
    runId,
    resume: true,
  };
  void startRun(merged)
    .then((result) => {
      if (options.json) console.log(JSON.stringify(result, null, 2));
      if (result.status === "failed") process.exitCode = 1;
      if (result.status === "cancelled") process.exitCode = 130;
    })
    .catch((error) => {
      console.error(`mesh: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

function applyCommandLine(rest: string[], workspace: string): void {
  let runId = "";
  let step: string | undefined;
  let check = false;
  let root = workspace;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--step") step = rest[++index];
    else if (arg === "--check") check = true;
    else if (arg === "--workspace") root = resolve(rest[++index] ?? ".");
    else if (arg === "--help" || arg === "-h") {
      usage();
      return;
    } else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else if (!runId) runId = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!runId) throw new Error("usage: mesh apply <run_id> [--step id] [--check]");
  const result = applyRun(root, { runId, step, check });
  const verb = result.applied ? "applied" : "ready to apply";
  console.log(`${verb} ${result.files.length} file(s) from ${runId} (${result.mode})`);
  for (const file of result.files) console.log(`  ${file}`);
  if (!result.applied) console.log("run without --check to apply the patch");
}

function cleanCommandLine(rest: string[], workspace: string): void {
  let keep = 10;
  let all = false;
  let dryRun = false;
  let yes = false;
  let root = workspace;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--keep") {
      const value = Number(rest[++index]);
      if (!Number.isInteger(value) || value < 0) throw new Error("invalid --keep value");
      keep = value;
    } else if (arg === "--all") all = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--workspace") root = resolve(rest[++index] ?? ".");
    else if (arg === "--help" || arg === "-h") {
      usage();
      return;
    } else throw new Error(`unknown option: ${arg}`);
  }
  void cleanRuns(root, { keep, all, dryRun, yes })
    .then((result) => {
      if (result.dryRun) {
        console.log(`would remove ${result.removed.length} run(s), keep ${result.kept}:`);
        for (const id of result.removed) console.log(`  ${id}`);
      } else {
        console.log(`removed ${result.removed.length} run(s), kept ${result.kept}`);
      }
      if (result.orphans.length) console.log(`swept ${result.orphans.length} orphan run dir(s)`);
    })
    .catch((error) => {
      console.error(`mesh: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

function printStats(workspace: string, json: boolean): void {
  const stats = computeStats(workspace);
  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  const status = Object.entries(stats.byStatus)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  console.log(`Runs: ${stats.totalRuns}${status ? ` (${status})` : ""}`);
  console.log(`Avg duration: ${formatDuration(stats.avgDurationMs)}`);
  console.log(
    `Cost: ${formatUsd(stats.usage.costUsd)} · tokens in ${stats.usage.inputTokens} / out ${stats.usage.outputTokens}`,
  );
  if (stats.workflows.length) {
    console.log("");
    console.log("Workflow                        Runs  OK  Fail  Cancel  Cost");
    for (const entry of stats.workflows) {
      console.log(
        `${entry.workflow.padEnd(30)} ${String(entry.runs).padStart(4)} ${String(entry.completed).padStart(3)} ${String(entry.failed).padStart(5)} ${String(entry.cancelled).padStart(6)}  ${formatUsd(entry.costUsd)}`,
      );
    }
  }
  if (stats.recentFailures.length) {
    console.log("");
    console.log("Recent failures/cancellations:");
    for (const run of stats.recentFailures) {
      console.log(`  ${run.id}  ${run.status}  ${run.goal}`);
    }
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "--version" || command === "version") {
    console.log(VERSION);
    return;
  }

  const workspace = process.cwd();
  try {
    if (command === "doctor") {
      printDoctor(doctor(workspace));
      return;
    }
    if (command === "agents") {
      listAgents(workspace);
      return;
    }
    if (command === "init") {
      const parsed = takeWorkspace(rest, workspace);
      init(parsed.rest[0] ?? parsed.workspace);
      return;
    }
    if (command === "run") {
      runCommandLine(rest);
      return;
    }
    if (command === "retry") {
      retryCommandLine(rest);
      return;
    }
    if (command === "cancel") {
      const parsed = takeWorkspace(rest, workspace);
      const runId = parsed.rest[0];
      if (!runId) throw new Error("usage: mesh cancel <run_id>");
      cancelRun(parsed.workspace, runId);
      return;
    }
    if (command === "apply") {
      applyCommandLine(rest, workspace);
      return;
    }
    if (command === "clean") {
      cleanCommandLine(rest, workspace);
      return;
    }
    if (command === "stats") {
      const json = rest.includes("--json");
      const index = rest.indexOf("--workspace");
      const root = index >= 0 ? resolve(rest[index + 1] ?? ".") : workspace;
      printStats(root, json);
      return;
    }
    if (command === "status") {
      const parsed = takeWorkspace(rest, workspace);
      showStatus(parsed.workspace, parsed.rest[0]);
      return;
    }
    if (command === "logs") {
      const parsed = takeWorkspace(rest, workspace);
      const runId = parsed.rest[0];
      if (!runId) throw new Error("usage: mesh logs <run_id> [--step id]");
      const stepIndex = parsed.rest.indexOf("--step");
      printLogs(parsed.workspace, runId, stepIndex >= 0 ? parsed.rest[stepIndex + 1] : undefined);
      return;
    }
    if (command === "mcp") {
      runMcpServer();
      return;
    }
    if (command === "web") {
      startWebServer(parseWebOptions(rest));
      return;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    console.error(`mesh: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
