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
  }

  upsertRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, goal, workflow, status, source_root, workspace, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           goal = excluded.goal,
           workflow = excluded.workflow,
           status = excluded.status,
           source_root = excluded.source_root,
           workspace = excluded.workspace,
           updated_at = excluded.updated_at`,
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
      );
  }

  updateRunStatus(runId: string, status: string): void {
    this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), runId);
  }

  upsertStep(step: StepRecord): void {
    this.db
      .prepare(
        `INSERT INTO steps (id, run_id, name, agent, status, prompt, output, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           prompt = excluded.prompt,
           output = excluded.output,
           error = excluded.error,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at`,
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

  close(): void {
    this.db.close();
  }
}
