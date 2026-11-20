#!/usr/bin/env node
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configPath, packageRoot } from "./config.ts";
import { doctor, printDoctor } from "./doctor.ts";
import { runMcpServer } from "./mcp.ts";
import { listAgents, showStatus, startRun } from "./runner.ts";
import { startWebServer } from "./web.ts";
import type { RunOptions } from "./types.ts";

const VERSION = "0.1.0";

function usage(): void {
  console.log(`mesh ${VERSION} — local multi-agent orchestration

Usage:
  mesh doctor                         Check Node, git, config, and agent CLIs
  mesh agents                         List configured agents and capabilities
  mesh run <goal> [options]           Run a workflow on a goal
  mesh status [run_id]                Show a run or recent runs
  mesh logs <run_id> [--step id]      Print a run's event log
  mesh mcp                            Start the MCP server on stdio
  mesh web [options]                  Open a local read-only dashboard
  mesh init                           Create mesh.json and prompts/ if missing

Run options:
  --workflow <name>    Workflow from mesh.json (default: implement-review)
  --workspace <path>   Workspace to operate on (default: current directory)
  --run-id <id>        Reuse a run id (used by the MCP server)
  --dry-run            Replace every agent with the local mock (no model calls)
  --verbose            Stream agent text to stdout
  --quiet              Only errors and the final summary
  --json               Print a machine-readable result

Web options:
  --port <number>      Port to listen on (default: 4317)
  --host <address>     Bind address (default: 127.0.0.1)
  --workspace <path>   Workspace to read (default: current directory)

Examples:
  mesh doctor
  mesh run "Add pagination to the search endpoint" --verbose
  mesh run "Review the auth changes" --workflow implement-review-verify
  mesh web
`);
}

function parseRunOptions(args: string[]): RunOptions {
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
    } else if (arg === "--workspace") {
      options.workspace = resolve(args[++index] ?? ".");
    } else if (arg === "--run-id") {
      options.runId = args[++index] ?? "";
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--json") {
      options.json = true;
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
  if (!options.goal) throw new Error("missing goal");
  if (!options.workflow) throw new Error("missing --workflow value");
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
      init(rest[0] ?? workspace);
      return;
    }
    if (command === "run") {
      const options = parseRunOptions(rest);
      startRun(options)
        .then((result) => {
          if (options.json) console.log(JSON.stringify(result, null, 2));
          if (result.status === "failed") process.exitCode = 1;
        })
        .catch((error) => {
          console.error(`mesh: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        });
      return;
    }
    if (command === "status") {
      showStatus(workspace, rest[0]);
      return;
    }
    if (command === "logs") {
      const runId = rest[0];
      if (!runId) throw new Error("usage: mesh logs <run_id> [--step id]");
      const stepIndex = rest.indexOf("--step");
      printLogs(workspace, runId, stepIndex >= 0 ? rest[stepIndex + 1] : undefined);
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
