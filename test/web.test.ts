import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MeshDb } from "../src/db.ts";
import { createWebServer } from "../src/web.ts";

interface Harness {
  url: string;
  close(): Promise<void>;
}

async function serve(workspace: string): Promise<Harness> {
  const server = createWebServer({ workspace, port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function seed(workspace: string): { artifactId: number; staleArtifactId: number } {
  const db = new MeshDb(workspace);
  try {
    db.upsertRun({
      id: "run_1",
      goal: "ship the thing",
      workflow: "one",
      status: "completed",
      source_root: "/tmp/mesh-stale-root",
      workspace: "/tmp/mesh-stale-root/.mesh/runs/run_1/workspace",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    db.upsertStep({
      id: "run_1:s",
      run_id: "run_1",
      name: "s",
      agent: "mock",
      status: "completed",
      prompt: "p",
      output: "the output",
      error: null,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
    });

    const artifacts = join(workspace, ".mesh", "runs", "run_1", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const patch = join(artifacts, "diff.patch");
    writeFileSync(patch, "diff --git a/x b/x\n", "utf8");
    const output = join(artifacts, "output.md");
    writeFileSync(output, "# output\n", "utf8");

    db.addArtifact("run_1", "s", patch, "diff");
    db.addArtifact("run_1", "s", "/tmp/mesh-stale-root/.mesh/runs/run_1/artifacts/output.md", "step-output");

    const rows = db.getArtifacts("run_1");
    return { artifactId: rows[0].id, staleArtifactId: rows[1].id };
  } finally {
    db.close();
  }
}

test("web serves the dashboard and run endpoints", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mesh-web-"));
  const { artifactId, staleArtifactId } = seed(workspace);
  const harness = await serve(workspace);
  try {
    const page = await fetch(`${harness.url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Mesh<\/title>/);

    const runs = await (await fetch(`${harness.url}/api/runs`)).json();
    assert.equal(runs.workspace, workspace);
    assert.deepEqual(runs.runs.map((run: { id: string }) => run.id), ["run_1"]);

    const detail = await (await fetch(`${harness.url}/api/runs/run_1`)).json();
    assert.equal(detail.run.goal, "ship the thing");
    assert.equal(detail.steps.length, 1);
    assert.equal(detail.steps[0].output, "the output");
    assert.equal(detail.artifacts.length, 2);

    const direct = await fetch(`${harness.url}/api/artifacts/${artifactId}`);
    assert.equal(direct.status, 200);
    assert.match(await direct.text(), /diff --git/);

    // Artifacts recorded under the workspace's old root resolve to the new location.
    const rebased = await fetch(`${harness.url}/api/artifacts/${staleArtifactId}`);
    assert.equal(rebased.status, 200);
    assert.equal(await rebased.text(), "# output\n");
  } finally {
    await harness.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("web rejects unknown runs, unknown artifacts, and paths outside .mesh", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mesh-web-"));
  seed(workspace);
  const db = new MeshDb(workspace);
  let outsideId: number;
  try {
    db.addArtifact("run_1", "s", "/etc/hosts", "diff");
    outsideId = db.getArtifacts("run_1").at(-1)!.id;
  } finally {
    db.close();
  }

  const harness = await serve(workspace);
  try {
    assert.equal((await fetch(`${harness.url}/api/runs/missing`)).status, 404);
    assert.equal((await fetch(`${harness.url}/api/artifacts/99999`)).status, 404);
    assert.equal((await fetch(`${harness.url}/api/artifacts/${outsideId}`)).status, 404);
    assert.equal((await fetch(`${harness.url}/api/unknown`)).status, 404);
    assert.equal((await fetch(`${harness.url}/api/runs`, { method: "POST" })).status, 415);
  } finally {
    await harness.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" }).pid ?? 999_999;
}

test("web starts runs, streams progress, and cancels", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mesh-web-"));
  writeFileSync(
    join(workspace, "mesh.json"),
    JSON.stringify({
      agents: { mock: { command: "node", args: [], capabilities: ["test"], prompt: "arg" } },
      workflows: { one: { steps: [{ id: "only", agent: "mock", prompt: "web run {{goal}}" }] } },
    }),
    "utf8",
  );
  const harness = await serve(workspace);
  try {
    const headers = { "content-type": "application/json" };
    assert.equal((await fetch(`${harness.url}/api/runs`, { method: "POST", headers })).status, 400);

    const started = await fetch(`${harness.url}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ goal: "from the web", workflow: "one", dry_run: true }),
    });
    assert.equal(started.status, 202);
    const { run_id: runId } = (await started.json()) as { run_id: string };
    assert.match(runId, /^run_/);

    let status = "";
    for (let attempt = 0; attempt < 200 && !["completed", "failed", "cancelled"].includes(status); attempt += 1) {
      await new Promise((done) => setTimeout(done, 50));
      const detail = (await (await fetch(`${harness.url}/api/runs/${runId}`)).json()) as { run: { status: string } };
      status = detail.run.status;
    }
    assert.equal(status, "completed");

    let artifacts: Array<{ kind: string }> = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${harness.url}/api/runs/${runId}`);
      const payload = (await response.json()) as { artifacts?: Array<{ kind: string }>; error?: string };
      assert.ok(response.ok, `run detail failed: ${response.status} ${JSON.stringify(payload)}`);
      artifacts = payload.artifacts ?? [];
      if (artifacts.some((artifact) => artifact.kind === "summary")) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(artifacts.some((artifact) => artifact.kind === "summary"), `no summary artifact: ${JSON.stringify(artifacts)}`);

    const stream = await fetch(`${harness.url}/api/runs/${runId}/stream`);
    const events = await stream.text();
    assert.match(events, /event: snapshot/);
    assert.match(events, /event: done/);
  } finally {
    await harness.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("web cancels a run whose runner is gone", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mesh-web-"));
  const db = new MeshDb(workspace);
  try {
    db.upsertRun({
      id: "run_dead",
      goal: "abandoned",
      workflow: "one",
      status: "running",
      source_root: workspace,
      workspace: join(workspace, ".mesh", "runs", "run_dead", "workspace"),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      pid: String(deadPid()),
    });
  } finally {
    db.close();
  }
  const harness = await serve(workspace);
  try {
    const response = await fetch(`${harness.url}/api/runs/run_dead/cancel`, { method: "POST" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string };
    assert.equal(body.status, "cancelled");
    const detail = (await (await fetch(`${harness.url}/api/runs/run_dead`)).json()) as { run: { status: string } };
    assert.equal(detail.run.status, "cancelled");
    assert.equal((await fetch(`${harness.url}/api/runs/missing/cancel`, { method: "POST" })).status, 404);
  } finally {
    await harness.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
