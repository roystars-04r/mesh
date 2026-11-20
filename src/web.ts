import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { startBackgroundRun } from "./background.ts";
import { loadConfig } from "./config.ts";
import { MeshDb } from "./db.ts";
import { cancelRun } from "./runner.ts";
import type { ArtifactRecord } from "./types.ts";
import { isTerminalStatus } from "./util.ts";

const MAX_ARTIFACT_BYTES = 2_000_000;
const MAX_BODY_BYTES = 64 * 1024;
const HTML = readFileSync(new URL("./web.html", import.meta.url), "utf8");
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface WebOptions {
  workspace: string;
  port: number;
  host: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function resolveInsideMesh(workspace: string, candidate: string): string | null {
  const meshRoot = resolve(workspace, ".mesh");
  let root: string;
  let file: string;
  try {
    root = realpathSync(meshRoot);
    file = realpathSync(candidate);
  } catch {
    return null;
  }
  if (file !== root && !file.startsWith(`${root}${sep}`)) return null;
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

function artifactFile(workspace: string, artifact: ArtifactRecord, db: MeshDb): string | null {
  const direct = resolveInsideMesh(workspace, resolve(artifact.path));
  if (direct) return direct;
  // Runs created before the workspace was moved or renamed still store their
  // original root in the database; rebase the path onto the current workspace.
  const run = db.getRun(artifact.run_id);
  if (!run || !run.source_root) return null;
  const prefix = `${resolve(run.source_root)}${sep}`;
  const original = resolve(artifact.path);
  if (!original.startsWith(prefix)) return null;
  return resolveInsideMesh(workspace, resolve(workspace, original.slice(prefix.length)));
}

function limitFrom(value: string | null): number {
  const parsed = Number(value ?? "50");
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(200, Math.max(1, Math.trunc(parsed)));
}

/**
 * Reject cross-site POSTs. Browsers send Origin on cross-origin writes; a
 * missing Origin (curl, tests) is allowed, but a foreign one is not.
 */
function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = String(request.headers.host ?? "");
  try {
    const parsed = new URL(origin);
    if (parsed.host === host) return true;
    const hostname = host.replace(/:\d+$/, "");
    return LOOPBACK.has(parsed.hostname) && LOOPBACK.has(hostname);
  } catch {
    return false;
  }
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((done, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return done({});
      try {
        done(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function runPayload(db: MeshDb, runId: string) {
  const run = db.getRun(runId);
  if (!run) return null;
  return { run, steps: db.getSteps(runId) };
}

async function createRun(request: IncomingMessage, response: ServerResponse, workspace: string) {
  if (!originAllowed(request)) {
    sendJson(response, 403, { error: "cross-origin request rejected" });
    return;
  }
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.includes("application/json")) {
    sendJson(response, 415, { error: "expected application/json" });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(request)) as Record<string, unknown>;
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const goal = String(body.goal ?? "").trim();
  if (!goal) {
    sendJson(response, 400, { error: "goal is required" });
    return;
  }
  if (!existsSync(join(workspace, "mesh.json"))) {
    sendJson(response, 400, { error: `no mesh.json in ${workspace}` });
    return;
  }
  const maxCost = Number(body.max_cost_usd);
  let started;
  try {
    started = startBackgroundRun({
      goal,
      workflow: String(body.workflow ?? "implement-review"),
      workspace,
      dryRun: body.dry_run === true,
      maxCostUsd: Number.isFinite(maxCost) && maxCost > 0 ? maxCost : undefined,
      approveDangerous: body.approve_dangerous === true,
      notify: typeof body.notify === "string" ? body.notify : undefined,
    });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  sendJson(response, 202, { run_id: started.runId, status: "started", log: started.logPath });
}

function streamRun(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: string,
  runId: string,
): void {
  const db = new MeshDb(workspace);
  let initial;
  try {
    initial = runPayload(db, runId);
  } finally {
    db.close();
  }
  if (!initial) {
    sendJson(response, 404, { error: `run not found: ${runId}` });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let last = "";
  let finished = false;
  let poll: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  const send = (event: string, data: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    if (poll) clearInterval(poll);
    if (heartbeat) clearInterval(heartbeat);
    response.end();
  };
  const tick = () => {
    if (finished) return;
    const live = new MeshDb(workspace);
    try {
      const payload = runPayload(live, runId);
      if (!payload) {
        send("error", { error: "run disappeared" });
        finish();
        return;
      }
      const json = JSON.stringify(payload);
      if (json !== last) {
        last = json;
        send("snapshot", payload);
      }
      if (isTerminalStatus(payload.run.status)) {
        send("done", { status: payload.run.status });
        finish();
      }
    } catch (error) {
      send("error", { error: error instanceof Error ? error.message : String(error) });
      finish();
    } finally {
      live.close();
    }
  };

  send("snapshot", initial);
  if (isTerminalStatus(initial.run.status)) {
    send("done", { status: initial.run.status });
    finish();
    return;
  }
  poll = setInterval(tick, 1_000);
  heartbeat = setInterval(() => response.write(": ping\n\n"), 15_000);
  request.on("close", finish);
}

async function handle(request: IncomingMessage, response: ServerResponse, options: WebOptions): Promise<void> {
  const workspace = resolve(options.workspace);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (method === "POST") {
    if (url.pathname === "/api/runs") {
      await createRun(request, response, workspace);
      return;
    }
    const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch) {
      if (!originAllowed(request)) {
        sendJson(response, 403, { error: "cross-origin request rejected" });
        return;
      }
      const runId = decodeURIComponent(cancelMatch[1]);
      try {
        sendJson(response, 200, cancelRun(workspace, runId));
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  if (method !== "GET") {
    response.setHeader("allow", "GET, POST");
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendText(response, 200, HTML, "text/html; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, workspace });
    return;
  }

  if (url.pathname === "/api/config") {
    try {
      sendJson(response, 200, loadConfig(workspace));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/api/runs") {
    const db = new MeshDb(workspace);
    try {
      sendJson(response, 200, { workspace, runs: db.listRuns(limitFrom(url.searchParams.get("limit"))) });
    } finally {
      db.close();
    }
    return;
  }

  const streamMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
  if (streamMatch) {
    streamRun(request, response, workspace, decodeURIComponent(streamMatch[1]));
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const db = new MeshDb(workspace);
    try {
      const payload = runPayload(db, runId);
      if (!payload) {
        sendJson(response, 404, { error: `run not found: ${runId}` });
        return;
      }
      sendJson(response, 200, { ...payload, artifacts: db.getArtifacts(runId) });
    } finally {
      db.close();
    }
    return;
  }

  const artifactMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)$/);
  if (artifactMatch) {
    const artifactId = Number(artifactMatch[1]);
    const db = new MeshDb(workspace);
    try {
      const artifact = db.getArtifact(artifactId);
      if (!artifact) {
        sendJson(response, 404, { error: `artifact not found: ${artifactId}` });
        return;
      }
      const file = artifactFile(workspace, artifact, db);
      if (!file) {
        sendJson(response, 404, { error: "artifact file is unavailable" });
        return;
      }
      const stat = statSync(file);
      if (stat.size > MAX_ARTIFACT_BYTES) {
        sendJson(response, 413, { error: "artifact is too large to display" });
        return;
      }
      sendText(response, 200, readFileSync(file, "utf8"), "text/plain; charset=utf-8");
    } finally {
      db.close();
    }
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

export function createWebServer(options: WebOptions): Server {
  const workspace = resolve(options.workspace);
  return createServer((request, response) => {
    handle(request, response, { ...options, workspace }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) sendJson(response, 500, { error: message });
      else response.end();
    });
  });
}

export function startWebServer(options: WebOptions): void {
  const workspace = resolve(options.workspace);
  const server = createWebServer({ ...options, workspace });

  server.on("error", (error) => {
    console.error(`mesh web: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(options.port, options.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    const shown = options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
    console.log(`Mesh web: http://${shown}:${port}`);
    console.log(`workspace: ${workspace}`);
    if (!LOOPBACK.has(options.host)) {
      console.warn("warning: Mesh web has no authentication; only expose it on a trusted network.");
    }
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
