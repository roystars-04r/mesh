import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyRun } from "../src/apply.ts";
import { MeshDb } from "../src/db.ts";
import { cleanRuns } from "../src/maintenance.ts";
import { cancelRun, startRun } from "../src/runner.ts";
import { computeStats } from "../src/stats.ts";

const fixture = fileURLToPath(new URL("../fixtures/mock-agent.mjs", import.meta.url));

function makeWorkspace(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "mesh-flow-"));
  writeFileSync(join(dir, "mesh.json"), JSON.stringify(config), "utf8");
  return dir;
}

function makeGitWorkspace(config: unknown): string {
  const dir = makeWorkspace(config);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["-c", "user.name=Mesh", "-c", "user.email=mesh@local", "commit", "-q", "-m", "init"]);
  return dir;
}

const mockAgent = { command: process.execPath, args: [fixture], capabilities: ["test"], prompt: "arg" };

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

test("cancelRun stops a running step and marks the run cancelled", async () => {
  const dir = makeWorkspace({
    agents: { mock: mockAgent },
    workflows: { one: { steps: [{ id: "only", agent: "mock", prompt: "slow step [file:a.txt]" }] } },
  });
  process.env.MESH_MOCK_SLEEP = "3000";
  try {
    const run = startRun({
      goal: "stop me",
      workflow: "one",
      workspace: dir,
      dryRun: true,
      quiet: true,
      runId: "run_cancel_test",
    });
    await sleep(600);
    const cancel = cancelRun(dir, "run_cancel_test");
    assert.equal(cancel.status, "running");
    const result = await run;
    assert.equal(result.status, "cancelled");

    const db = new MeshDb(dir);
    try {
      assert.equal(db.getRun("run_cancel_test")?.status, "cancelled");
      assert.equal(db.getSteps("run_cancel_test")[0].status, "cancelled");
    } finally {
      db.close();
    }
  } finally {
    delete process.env.MESH_MOCK_SLEEP;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume reuses completed steps and retries the failed one", async () => {
  const config = (secondPrompt: string) => ({
    agents: { mock: mockAgent },
    workflows: {
      two: {
        steps: [
          { id: "one", agent: "mock", prompt: "first step" },
          { id: "two", agent: "mock", needs: ["one"], prompt: secondPrompt },
        ],
      },
    },
  });
  const dir = makeWorkspace(config("second step [fail]"));
  try {
    const first = await startRun({ goal: "resume me", workflow: "two", workspace: dir, dryRun: true, quiet: true });
    assert.equal(first.status, "failed");
    const db = new MeshDb(dir);
    try {
      assert.deepEqual(
        db.getSteps(first.runId).map((step) => [step.name, step.status]),
        [
          ["one", "completed"],
          ["two", "failed"],
        ],
      );
    } finally {
      db.close();
    }

    writeFileSync(join(dir, "mesh.json"), JSON.stringify(config("second step now succeeds")), "utf8");
    const second = await startRun({
      goal: "",
      workflow: "two",
      workspace: dir,
      dryRun: true,
      quiet: true,
      runId: first.runId,
      resume: true,
    });
    assert.equal(second.status, "completed");
    assert.deepEqual(
      second.steps.map((step) => [step.id, step.status]),
      [
        ["one", "skipped"],
        ["two", "completed"],
      ],
    );
    const after = new MeshDb(dir);
    try {
      assert.deepEqual(
        after.getSteps(first.runId).map((step) => step.status),
        ["completed", "completed"],
      );
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval-required steps wait for --yes", async () => {
  const config = {
    agents: { mock: mockAgent },
    workflows: { one: { steps: [{ id: "only", agent: "mock", prompt: "approve me", approve: true }] } },
  };
  const dir = makeWorkspace(config);
  try {
    const blocked = await startRun({ goal: "gate", workflow: "one", workspace: dir, quiet: true, runId: "run_gate" });
    assert.equal(blocked.status, "cancelled");
    const db = new MeshDb(dir);
    try {
      assert.equal(db.getSteps("run_gate")[0].status, "cancelled");
      assert.match(db.getSteps("run_gate")[0].error ?? "", /approval required/);
    } finally {
      db.close();
    }

    const approved = await startRun({
      goal: "gate",
      workflow: "one",
      workspace: dir,
      quiet: true,
      runId: "run_gate",
      yes: true,
    });
    assert.equal(approved.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("budget stops the run after an expensive step", async () => {
  const dir = makeWorkspace({
    agents: { mock: mockAgent },
    workflows: {
      two: {
        steps: [
          { id: "one", agent: "mock", prompt: "costly step" },
          { id: "two", agent: "mock", needs: ["one"], prompt: "never runs" },
        ],
      },
    },
  });
  process.env.MESH_MOCK_USAGE = "1";
  try {
    const result = await startRun({
      goal: "budget",
      workflow: "two",
      workspace: dir,
      dryRun: true,
      quiet: true,
      maxCostUsd: 0.1,
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.steps.map((step) => step.status), ["completed"]);
    const db = new MeshDb(dir);
    try {
      const run = db.getRun(result.runId);
      assert.equal(run?.status, "failed");
      assert.equal(run?.total_cost_usd, 0.5);
      assert.deepEqual(db.getSteps(result.runId).map((step) => step.name), ["one"]);
    } finally {
      db.close();
    }
  } finally {
    delete process.env.MESH_MOCK_USAGE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("independent steps run in parallel worktrees and merge", async () => {
  const dir = makeGitWorkspace({
    agents: { mock: mockAgent },
    workflows: {
      fanout: {
        steps: [
          { id: "alpha", agent: "mock", prompt: "write alpha [file:alpha.txt]" },
          { id: "beta", agent: "mock", prompt: "write beta [file:beta.txt]" },
        ],
      },
    },
  });
  try {
    const result = await startRun({
      goal: "fan out",
      workflow: "fanout",
      workspace: dir,
      dryRun: true,
      quiet: true,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.steps.map((step) => step.status), ["completed", "completed"]);
    assert.ok(existsSync(join(result.runDir, "workspace", "alpha.txt")));
    assert.ok(existsSync(join(result.runDir, "workspace", "beta.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capability routing falls back to the next capable agent", async () => {
  const dir = makeWorkspace({
    agents: {
      ghost: { command: "mesh-definitely-missing-agent", args: [], capabilities: ["test"], prompt: "none" },
      mock: mockAgent,
    },
    workflows: { one: { steps: [{ id: "only", capability: "test", prompt: "fallback please" }] } },
  });
  try {
    const result = await startRun({ goal: "fallback", workflow: "one", workspace: dir, quiet: true });
    assert.equal(result.status, "completed");
    assert.equal(result.steps[0].agent, "mock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyRun checks and applies a finished run's diff", async () => {
  const dir = makeGitWorkspace({
    agents: { mock: mockAgent },
    workflows: { one: { steps: [{ id: "only", agent: "mock", prompt: "make a change" }] } },
  });
  try {
    const result = await startRun({ goal: "apply me", workflow: "one", workspace: dir, dryRun: true, quiet: true });
    const check = applyRun(dir, { runId: result.runId, check: true });
    assert.equal(check.applied, false);
    assert.deepEqual(check.files, ["mesh-mock-change.txt"]);
    assert.equal(existsSync(join(dir, "mesh-mock-change.txt")), false);

    const applied = applyRun(dir, { runId: result.runId });
    assert.equal(applied.applied, true);
    assert.match(readFileSync(join(dir, "mesh-mock-change.txt"), "utf8"), /mock agent touched/);
    assert.throws(() => applyRun(dir, { runId: result.runId, check: true }), /does not apply cleanly/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanRuns supports dry runs and removes old runs with --all", async () => {
  const dir = makeWorkspace({ agents: { mock: mockAgent }, workflows: { one: { steps: [{ id: "a", agent: "mock" }] } } });
  try {
    const result = await startRun({ goal: "clean", workflow: "one", workspace: dir, dryRun: true, quiet: true });
    const orphanDir = join(dir, ".mesh", "runs", "orphan_run");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, "x.txt"), "orphan", "utf8");

    const dry = await cleanRuns(dir, { all: true, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.removed.includes(result.runId));
    assert.ok(dry.removed.includes("orphan_run"));
    assert.ok(existsSync(join(dir, ".mesh", "runs", result.runId)));

    const cleaned = await cleanRuns(dir, { all: true, yes: true });
    assert.ok(cleaned.removed.includes(result.runId));
    assert.equal(existsSync(join(dir, ".mesh", "runs", result.runId)), false);
    assert.equal(existsSync(orphanDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeStats aggregates runs and recent failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-stats-"));
  try {
    const db = new MeshDb(dir);
    try {
      const base = {
        source_root: dir,
        workspace: join(dir, "workspace"),
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:01:00.000Z",
      };
      db.upsertRun({ ...base, id: "run_a", goal: "a", workflow: "w", status: "completed", total_cost_usd: 0.2 });
      db.upsertRun({ ...base, id: "run_b", goal: "b", workflow: "w", status: "failed", total_cost_usd: 0.1 });
    } finally {
      db.close();
    }
    const stats = computeStats(dir);
    assert.equal(stats.totalRuns, 2);
    assert.deepEqual(stats.byStatus, { completed: 1, failed: 1 });
    assert.ok(Math.abs(stats.usage.costUsd - 0.3) < 1e-9);
    assert.equal(stats.workflows[0].workflow, "w");
    assert.equal(stats.workflows[0].failed, 1);
    assert.equal(stats.recentFailures.length, 1);
    assert.equal(stats.avgDurationMs, 60_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
