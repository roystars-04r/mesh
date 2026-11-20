import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { MeshDb } from "./db.ts";
import type { ArtifactRecord } from "./types.ts";

const MAX_ARTIFACT_BYTES = 2_000_000;
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

function handle(request: IncomingMessage, response: ServerResponse, options: WebOptions): void {
  const workspace = resolve(options.workspace);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method !== "GET") {
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

  if (url.pathname === "/api/runs") {
    const db = new MeshDb(workspace);
    try {
      sendJson(response, 200, { workspace, runs: db.listRuns(limitFrom(url.searchParams.get("limit"))) });
    } finally {
      db.close();
    }
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const db = new MeshDb(workspace);
    try {
      const run = db.getRun(runId);
      if (!run) {
        sendJson(response, 404, { error: `run not found: ${runId}` });
        return;
      }
      sendJson(response, 200, {
        run,
        steps: db.getSteps(runId),
        artifacts: db.getArtifacts(runId),
      });
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
    try {
      handle(request, response, { ...options, workspace });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) sendJson(response, 500, { error: message });
      else response.end();
    }
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
