export type PromptMode = "arg" | "stdin" | "arg-template" | "none";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

export interface AgentConfig {
  command: string;
  args?: string[];
  versionArgs?: string[];
  capabilities: string[];
  prompt: PromptMode;
  timeoutSec?: number;
  env?: Record<string, string>;
}

export interface StepConfig {
  id: string;
  agent?: string;
  capability?: string;
  needs?: string[];
  promptFile?: string;
  prompt?: string;
  /** Ask the terminal operator before running this step. */
  approve?: boolean;
}

export interface WorkflowConfig {
  steps: StepConfig[];
}

export interface BudgetConfig {
  maxCostUsd?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface MeshConfig {
  agents: Record<string, AgentConfig>;
  workflows: Record<string, WorkflowConfig>;
  budget?: BudgetConfig;
  notify?: { webhook?: string };
}

export interface RunOptions {
  goal: string;
  workflow: string;
  workspace: string;
  workflowExplicit?: boolean;
  runId?: string;
  resume?: boolean;
  retry?: number;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  maxCostUsd?: number;
  notify?: string;
}

export interface AgentEvent {
  type: string;
  text?: string;
  raw?: unknown;
  at: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AgentResult {
  exitCode: number;
  finalText: string;
  events: AgentEvent[];
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled?: boolean;
  /** The agent command could not be spawned (for example, it is not installed). */
  spawnError?: boolean;
  usage?: Usage;
}

export interface RunRecord {
  id: string;
  goal: string;
  workflow: string;
  status: RunStatus | string;
  source_root: string;
  workspace: string;
  created_at: string;
  updated_at: string;
  pid?: string | null;
  total_cost_usd?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export interface StepRecord {
  id: string;
  run_id: string;
  name: string;
  agent: string;
  status: StepStatus | string;
  prompt: string | null;
  output: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  usage?: string | null;
  attempt?: number | null;
}

export interface ArtifactRecord {
  id: number;
  run_id: string;
  step_id: string | null;
  path: string;
  kind: string;
  created_at: string;
}
