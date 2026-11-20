import { MeshDb } from "./db.ts";
import type { Usage } from "./types.ts";
import { isTerminalStatus } from "./util.ts";

export interface WorkflowStats {
  workflow: string;
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  costUsd: number;
}

export interface StatsResult {
  totalRuns: number;
  byStatus: Record<string, number>;
  usage: Usage;
  avgDurationMs: number;
  workflows: WorkflowStats[];
  recentFailures: Array<{ id: string; goal: string; status: string; updated_at: string }>;
}

export function computeStats(workspace: string, limit = 1_000): StatsResult {
  const db = new MeshDb(workspace);
  try {
    const runs = db.listRuns(limit);
    const byStatus: Record<string, number> = {};
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const workflows = new Map<string, WorkflowStats>();
    let durationSum = 0;
    let durationCount = 0;
    const recentFailures: StatsResult["recentFailures"] = [];

    for (const run of runs) {
      byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
      usage.inputTokens += run.input_tokens ?? 0;
      usage.outputTokens += run.output_tokens ?? 0;
      usage.costUsd += run.total_cost_usd ?? 0;

      const entry = workflows.get(run.workflow) ?? {
        workflow: run.workflow,
        runs: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        costUsd: 0,
      };
      entry.runs += 1;
      entry.costUsd += run.total_cost_usd ?? 0;
      if (run.status === "completed") entry.completed += 1;
      else if (run.status === "failed") entry.failed += 1;
      else if (run.status === "cancelled") entry.cancelled += 1;
      workflows.set(run.workflow, entry);

      if (isTerminalStatus(run.status)) {
        const started = Date.parse(run.created_at);
        const finished = Date.parse(run.updated_at);
        if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
          durationSum += finished - started;
          durationCount += 1;
        }
      }
      if ((run.status === "failed" || run.status === "cancelled") && recentFailures.length < 5) {
        recentFailures.push({ id: run.id, goal: run.goal, status: run.status, updated_at: run.updated_at });
      }
    }

    return {
      totalRuns: runs.length,
      byStatus,
      usage,
      avgDurationMs: durationCount ? Math.round(durationSum / durationCount) : 0,
      workflows: [...workflows.values()].sort((a, b) => b.runs - a.runs),
      recentFailures,
    };
  } finally {
    db.close();
  }
}
