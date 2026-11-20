import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { ArtifactRecord, RunRecord, StepRecord } from "./types.ts";
import { ensureDir, nowIso } from "./util.ts";

export class MeshDb {
  readonly path: string;
  private db: DatabaseSync;

  constructor(workspace: string) {
    const dir = join(workspace, ".mesh");
    ensureDir(dir);
    this.path = join(dir, "mesh.db");
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        source_root TEXT NOT NULL,
        workspace TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT,
        output TEXT,
        error TEXT,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step_id TEXT,
        type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step_id TEXT,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
    `);
    this.migrate();
  }

  /** Additive schema changes so existing .mesh/mesh.db files keep working. */
  private migrate(): void {
    const columns = (table: string): Set<string> => {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return new Set(rows.map((row) => row.name));
    };
    const add = (table: string, column: string, ddl: string): void => {
      if (!columns(table).has(column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      }
    };
    add("runs", "pid", "TEXT");
    add("runs", "total_cost_usd", "REAL NOT NULL DEFAULT 0");
    add("runs", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
    add("runs", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
    add("steps", "usage", "TEXT");
    add("steps", "attempt", "INTEGER NOT NULL DEFAULT 0");
  }

  upsertRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, goal, workflow, status, source_root, workspace, created_at, updated_at, pid, total_cost_usd, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           goal = excluded.goal,
           workflow = excluded.workflow,
           status = excluded.status,
           source_root = excluded.source_root,
           workspace = excluded.workspace,
           updated_at = excluded.updated_at,
           pid = excluded.pid`,
      )
      .run(
        run.id,
        run.goal,
        run.workflow,
        run.status,
        run.source_root,
        run.workspace,
        run.created_at,
        run.updated_at,
        run.pid ?? null,
        run.total_cost_usd ?? 0,
        run.input_tokens ?? 0,
        run.output_tokens ?? 0,
      );
  }

  updateRunStatus(runId: string, status: string, options: { clearPid?: boolean } = {}): void {
    if (options.clearPid) {
      this.db.prepare("UPDATE runs SET status = ?, updated_at = ?, pid = NULL WHERE id = ?").run(status, nowIso(), runId);
      return;
    }
    this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), runId);
  }

  setRunPid(runId: string, pid: number | null): void {
    this.db.prepare("UPDATE runs SET pid = ?, updated_at = ? WHERE id = ?").run(pid === null ? null : String(pid), nowIso(), runId);
  }

  addRunUsage(runId: string, usage: { inputTokens: number; outputTokens: number; costUsd: number }): void {
    this.db
      .prepare(
        `UPDATE runs SET total_cost_usd = COALESCE(total_cost_usd, 0) + ?,
           input_tokens = COALESCE(input_tokens, 0) + ?,
           output_tokens = COALESCE(output_tokens, 0) + ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(usage.costUsd, usage.inputTokens, usage.outputTokens, nowIso(), runId);
  }

  upsertStep(step: StepRecord): void {
    this.db
      .prepare(
        `INSERT INTO steps (id, run_id, name, agent, status, prompt, output, error, started_at, finished_at, usage, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent = excluded.agent,
           status = excluded.status,
           prompt = excluded.prompt,
           output = excluded.output,
           error = excluded.error,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           usage = excluded.usage,
           attempt = excluded.attempt`,
      )
      .run(
        step.id,
        step.run_id,
        step.name,
        step.agent,
        step.status,
        step.prompt,
        step.output,
        step.error,
        step.started_at,
        step.finished_at,
        step.usage ?? null,
        step.attempt ?? 0,
      );
  }

  addEvent(runId: string, stepId: string | null, type: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (run_id, step_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, stepId, type, JSON.stringify(payload ?? null), nowIso());
  }

  addArtifact(runId: string, stepId: string | null, path: string, kind: string): void {
    this.db
      .prepare("INSERT INTO artifacts (run_id, step_id, path, kind, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, stepId, path, kind, nowIso());
  }

  getRun(runId: string): RunRecord | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRecord | undefined;
  }

  listRuns(limit = 20): RunRecord[] {
    return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as RunRecord[];
  }

  getSteps(runId: string): StepRecord[] {
    return this.db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY started_at ASC").all(runId) as StepRecord[];
  }

  getArtifacts(runId: string): ArtifactRecord[] {
    return this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY id ASC").all(runId) as ArtifactRecord[];
  }

  getArtifact(id: number): ArtifactRecord | undefined {
    return this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRecord | undefined;
  }

  deleteRun(runId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM events WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
