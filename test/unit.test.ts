import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeEvent } from "../src/adapters.ts";
import { interpolate, orderSteps } from "../src/config.ts";
import { MeshDb } from "../src/db.ts";
import { startRun } from "../src/runner.ts";

test("interpolate replaces known variables and leaves unknown placeholders", () => {
  const result = interpolate("goal={{goal}} missing={{nope}}", { goal: "ship it" });
  assert.equal(result, "goal=ship it missing={{nope}}");
});

test("orderSteps respects needs and rejects cycles", () => {
  const ordered = orderSteps({
    steps: [
      { id: "review", agent: "codex", needs: ["implement"] },
      { id: "implement", agent: "claude" },
    ],
  });
  assert.deepEqual(ordered.map((step) => step.id), ["implement", "review"]);
  assert.throws(
    () =>
      orderSteps({
        steps: [
          { id: "a", agent: "claude", needs: ["b"] },
          { id: "b", agent: "codex", needs: ["a"] },
        ],
      }),
    /cycle/,
  );
});

test("normalizeEvent extracts Claude assistant and result text", () => {
  const assistant = normalizeEvent({
    type: "assistant",
    message: { content: [{ type: "text", text: "working" }] },
  });
  assert.equal(assistant.type, "assistant");
  assert.equal(assistant.text, "working");

  const result = normalizeEvent({ type: "result", result: "done" });
  assert.equal(result.text, "done");
});

test("MeshDb persists runs, steps, and artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-db-"));
  try {
    const db = new MeshDb(dir);
    db.upsertRun({
      id: "run_1",
      goal: "g",
      workflow: "w",
      status: "running",
      source_root: dir,
      workspace: join(dir, "workspace"),
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
      output: "o",
      error: null,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
    });
    db.addArtifact("run_1", "s", "/tmp/out.md", "step-output");
    assert.equal(db.getRun("run_1")?.status, "running");
    assert.equal(db.getSteps("run_1").length, 1);
    assert.equal(db.getArtifacts("run_1").length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startRun executes a workflow with the mock agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-run-"));
  try {
    writeFileSync(
      join(dir, "mesh.json"),
      JSON.stringify({
        agents: {
          mock: { command: "node", args: [], capabilities: ["test"], prompt: "arg" },
        },
        workflows: {
          one: { steps: [{ id: "only", agent: "mock", prompt: "do {{goal}}" }] },
        },
      }),
      "utf8",
    );
    const result = await startRun({
      goal: "the thing",
      workflow: "one",
      workspace: dir,
      dryRun: true,
      quiet: true,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.steps.length, 1);
    const output = readFileSync(join(result.runDir, "steps", "only.md"), "utf8");
    assert.match(output, /mock agent completed/);
    assert.ok(readFileSync(join(result.runDir, "artifacts", "diff-only.patch"), "utf8").includes("mesh-mock-change.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
