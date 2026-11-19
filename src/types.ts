export type PromptMode = "arg" | "stdin" | "arg-template" | "none";

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
  agent: string;
  needs?: string[];
  promptFile?: string;
  prompt?: string;
}

export interface WorkflowConfig {
  steps: StepConfig[];
}

export interface MeshConfig {
  agents: Record<string, AgentConfig>;
  workflows: Record<string, WorkflowConfig>;
}

export interface RunOptions {
  goal: string;
  workflow: string;
  workspace: string;
  runId?: string;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  dryRun?: boolean;
}

export interface AgentEvent {
  type: string;
  text?: string;
  raw?: unknown;
  at: string;
}

export interface AgentResult {
  exitCode: number;
  finalText: string;
  events: AgentEvent[];
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunRecord {
  id: string;
  goal: string;
  workflow: string;
  status: string;
  source_root: string;
  workspace: string;
  created_at: string;
  updated_at: string;
}

export interface StepRecord {
  id: string;
  run_id: string;
  name: string;
  agent: string;
  status: string;
  prompt: string | null;
  output: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ArtifactRecord {
  id: number;
  run_id: string;
  step_id: string | null;
  path: string;
  kind: string;
  created_at: string;
}
