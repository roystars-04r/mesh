import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { MeshDb } from "./db.ts";
import { newId, ensureDir, nowIso } from "./util.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "mesh", version: "0.1.0" };

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

const TOOLS = [
  {
    name: "mesh_run",
    description:
      "Start a local multi-agent workflow. Returns immediately with a run id; use mesh_status to poll. Default workflow: implement-review (Claude implements, Codex reviews).",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What should be built or changed" },
        workflow: { type: "string", description: "Workflow name from mesh.json (default implement-review)" },
        workspace: { type: "string", description: "Absolute workspace path (defaults to the MCP server cwd)" },
        dry_run: { type: "boolean", description: "Use the local mock agent (no model calls)" },
      },
      required: ["goal"],
    },
  },
  {
    name: "mesh_status",
    description: "Show one run with its steps and artifacts, or recent runs when run_id is omitted.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" }, workspace: { type: "string" } },
    },
  },
  {
    name: "mesh_agents",
    description: "List configured agents and their declared capabilities.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mesh_artifacts",
    description: "List artifacts produced by a run.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" }, workspace: { type: "string" } },
      required: ["run_id"],
    },
  },
];

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
}

function startBackgroundRun(args: Record<string, unknown>): unknown {
  const goal = String(args.goal ?? "").trim();
  if (!goal) throw new Error("goal is required");
  const workspace = resolve(String(args.workspace ?? process.cwd()));
  const workflow = String(args.workflow ?? "implement-review");
  const runId = newId("run");
  const runDir = join(workspace, ".mesh", "runs", runId);
  ensureDir(runDir);
  const db = new MeshDb(workspace);
  db.upsertRun({
    id: runId,
    goal,
    workflow,
    status: "queued",
    source_root: workspace,
    workspace: join(runDir, "workspace"),
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  db.close();

  const logPath = join(runDir, "runner.log");
  const logFd = openSync(logPath, "a");
  const cli = resolve(process.argv[1]);
  const cmdArgs = [
    cli,
    "run",
    goal,
    "--workflow",
    workflow,
    "--workspace",
    workspace,
    "--run-id",
    runId,
    "--quiet",
  ];
  if (args.dry_run === true) cmdArgs.push("--dry-run");
  const child = spawn(process.execPath, cmdArgs, {
    cwd: workspace,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  return { run_id: runId, status: "started", log: logPath };
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

function handleTool(name: string, args: Record<string, unknown>): unknown {
  const workspace = resolve(String(args.workspace ?? process.cwd()));
  switch (name) {
    case "mesh_run":
      return startBackgroundRun(args);
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
