import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Rpc {
  request(id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  call(id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function rpc(client: ChildProcessWithoutNullStreams): Rpc {
  let buffer = "";
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  client.stdout.setEncoding("utf8");
  client.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = pending.get(Number(message.id));
      if (waiter) {
        pending.delete(Number(message.id));
        waiter(message);
      }
    }
  });

  const request = (id: number, method: string, params?: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 20_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      client.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return {
    request,
    async call(id, name, args) {
      const response = await request(id, "tools/call", { name, arguments: args });
      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      const text = result.content[0]?.text ?? "null";
      return { isError: result.isError === true, value: JSON.parse(text) as Record<string, unknown> };
    },
  };
}

test("mcp exposes run, status, logs, cancel, and apply tools", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mesh-mcp-"));
  writeFileSync(
    join(workspace, "mesh.json"),
    JSON.stringify({
      agents: { mock: { command: "node", args: [], capabilities: ["test"], prompt: "arg" } },
      workflows: { one: { steps: [{ id: "only", agent: "mock", prompt: "mcp {{goal}}" }] } },
    }),
    "utf8",
  );

  const client = spawn(process.execPath, [cli, "mcp"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  try {
    const api = rpc(client);
    await api.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const listed = await api.request(2, "tools/list");
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    for (const name of ["mesh_run", "mesh_status", "mesh_logs", "mesh_cancel", "mesh_apply"]) {
      assert.ok(tools.includes(name), `missing tool ${name}`);
    }

    const started = await api.call(3, "mesh_run", { goal: "mcp run", workflow: "one", dry_run: true });
    assert.equal(started.isError, false);
    const runId = String(started.value.run_id);
    assert.match(runId, /^run_/);

    let status = "";
    for (let attempt = 0; attempt < 100 && !["completed", "failed", "cancelled"].includes(status); attempt += 1) {
      await new Promise((done) => setTimeout(done, 50));
      const response = await api.call(4, "mesh_status", { run_id: runId });
      status = String((response.value.run as { status: string }).status);
    }
    assert.equal(status, "completed");

    const logs = await api.call(5, "mesh_logs", { run_id: runId, limit: 5 });
    assert.ok(Array.isArray(logs.value) && logs.value.length > 0);

    const cancel = await api.call(6, "mesh_cancel", { run_id: runId });
    assert.equal(String(cancel.value.status), "completed");
  } finally {
    client.kill("SIGTERM");
    rmSync(workspace, { recursive: true, force: true });
  }
});
