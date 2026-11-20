import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { applyRun } from "./apply.ts";
import { startBackgroundRun } from "./background.ts";
import { loadConfig } from "./config.ts";
import { MeshDb } from "./db.ts";
import { cancelRun } from "./runner.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "mesh", version: "0.2.0" };

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const RUN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    run_id: { type: "string" },
    status: { type: "string" },
    log: { type: "string" },
  },
};

const TOOLS = [
  {
    name: "mesh_run",
    description:
      "Start a local multi-agent workflow in the background. Returns immediately with a run id; use mesh_status to poll and mesh_logs to follow progress. Default workflow: implement-review (Claude implements, Codex reviews).",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What should be built or changed" },
        workflow: { type: "string", description: "Workflow name from mesh.json (default implement-review)" },
        workspace: { type: "string", description: "Absolute workspace path (defaults to the MCP server cwd)" },
        dry_run: { type: "boolean", description: "Use the local mock agent (no model calls)" },
        max_cost_usd: { type: "number", description: "Stop before the next step once the run costs more than this" },
        approve_dangerous: { type: "boolean", description: "Auto-approve steps marked approve: true" },
        notify: { type: "string", description: "Webhook URL to POST a summary to when the run ends" },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    outputSchema: RUN_OUTPUT_SCHEMA,
  },
  {
    name: "mesh_status",
    description: "Show one run with its steps and artifacts, or recent runs when run_id is omitted.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" }, workspace: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "mesh_agents",
    description: "List configured agents and their declared capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mesh_artifacts",
    description: "List artifacts produced by a run.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" }, workspace: { type: "string" } },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_cancel",
    description: "Cancel a running or queued run. The runner aborts the active agent and marks the run cancelled.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" }, workspace: { type: "string" } },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_logs",
    description: "Read the event log of a run (optionally filtered to one step), newest last.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        step: { type: "string", description: "Only events for this step id" },
        limit: { type: "number", description: "Return at most this many events (default 100)" },
        workspace: { type: "string" },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_apply",
    description: "Apply a finished run's diff to the workspace (or only check that it applies).",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        step: { type: "string", description: "Apply only this step's diff" },
        check: { type: "boolean", description: "Only verify that the patch applies" },
        workspace: { type: "string" },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
];

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
}

function statusPayload(workspace: string, runId?: string): unknown {
  const db = new MeshDb(workspace);
  try {
    if (!runId) return db.listRuns();
    const run = db.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    return { run, steps: db.getSteps(runId), artifacts: db.getArtifacts(runId) };
  } finally {
    db.close();
  }
}

function logsPayload(workspace: string, runId: string, step?: string, limit = 100): string[] {
  const path = join(resolve(workspace), ".mesh", "runs", runId, "events.ndjson");
  if (!existsSync(path)) throw new Error(`no events for run ${runId}`);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const events: string[] = [];
  for (const line of lines) {
    if (step) {
      try {
        const parsed = JSON.parse(line) as { step_id?: string };
        if (parsed.step_id !== step) continue;
      } catch {
        // keep malformed lines so the caller can see them
      }
    }
    events.push(line);
  }
  return events.slice(-Math.max(1, limit));
}

function handleTool(name: string, args: Record<string, unknown>): unknown {
  const workspace = resolve(String(args.workspace ?? process.cwd()));
  switch (name) {
    case "mesh_run": {
      const goal = String(args.goal ?? "").trim();
      if (!goal) throw new Error("goal is required");
      if (!existsSync(join(workspace, "mesh.json"))) throw new Error(`no mesh.json in ${workspace}`);
      const started = startBackgroundRun({
        goal,
        workflow: String(args.workflow ?? "implement-review"),
        workspace,
        dryRun: args.dry_run === true,
        maxCostUsd: typeof args.max_cost_usd === "number" ? args.max_cost_usd : undefined,
        approveDangerous: args.approve_dangerous === true,
        notify: typeof args.notify === "string" ? args.notify : undefined,
      });
      return { run_id: started.runId, status: "started", log: started.logPath };
    }
    case "mesh_status":
      return statusPayload(workspace, args.run_id ? String(args.run_id) : undefined);
    case "mesh_agents": {
      const config = loadConfig(workspace);
      return Object.entries(config.agents).map(([id, agent]) => ({
        id,
        command: agent.command,
        capabilities: agent.capabilities,
      }));
    }
    case "mesh_artifacts": {
      const runId = String(args.run_id ?? "");
      if (!runId) throw new Error("run_id is required");
      const db = new MeshDb(workspace);
      try {
        if (!db.getRun(runId)) throw new Error(`run not found: ${runId}`);
        return db.getArtifacts(runId);
      } finally {
        db.close();
      }
    }
    case "mesh_cancel": {
      const runId = String(args.run_id ?? "");
      if (!runId) throw new Error("run_id is required");
      return cancelRun(workspace, runId);
    }
    case "mesh_logs": {
      const runId = String(args.run_id ?? "");
      if (!runId) throw new Error("run_id is required");
      const limit = typeof args.limit === "number" ? args.limit : 100;
      return logsPayload(workspace, runId, args.step ? String(args.step) : undefined, limit);
    }
    case "mesh_apply": {
      const runId = String(args.run_id ?? "");
      if (!runId) throw new Error("run_id is required");
      return applyRun(workspace, {
        runId,
        step: args.step ? String(args.step) : undefined,
        check: args.check === true,
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function runMcpServer(): void {
  process.stderr.write("mesh mcp: listening on stdio\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      fail(null, -32700, "parse error");
      return;
    }
    if (request.id === undefined) return; // notification
    try {
      if (request.method === "initialize") {
        ok(request.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        return;
      }
      if (request.method === "ping") {
        ok(request.id, {});
        return;
      }
      if (request.method === "tools/list") {
        ok(request.id, { tools: TOOLS });
        return;
      }
      if (request.method === "tools/call") {
        const params = request.params ?? {};
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const result = handleTool(name, args);
        ok(request.id, textResult(result));
        return;
      }
      fail(request.id, -32601, `method not found: ${request.method}`);
    } catch (error) {
      ok(request.id, textResult(String(error instanceof Error ? error.message : error), true));
    }
  });
}
