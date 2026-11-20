import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, MeshConfig, StepConfig, WorkflowConfig } from "./types.ts";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function configPath(workspace: string): string {
  return join(resolve(workspace), "mesh.json");
}

export function loadConfig(workspace: string): MeshConfig {
  const path = configPath(workspace);
  if (!existsSync(path)) {
    throw new Error(`mesh.json not found in ${resolve(workspace)}. Run "mesh init" here, cd into a project that has mesh.json, or pass --workspace <path>.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid mesh.json: ${String(error)}`);
  }
  const config = parsed as MeshConfig;
  if (!config || typeof config !== "object" || !config.agents || !config.workflows) {
    throw new Error("mesh.json must contain agents and workflows objects");
  }
  for (const [id, agent] of Object.entries(config.agents)) {
    if (!agent.command || !Array.isArray(agent.args ?? []) || !Array.isArray(agent.capabilities)) {
      throw new Error(`agent "${id}" must have command, args array, and capabilities array`);
    }
    if (!["arg", "stdin", "arg-template", "none"].includes(agent.prompt)) {
      throw new Error(`agent "${id}" has invalid prompt mode "${agent.prompt}"`);
    }
  }
  for (const [id, workflow] of Object.entries(config.workflows)) {
    if (!workflow || !Array.isArray(workflow.steps) || workflow.steps.length === 0) {
      throw new Error(`workflow "${id}" must contain a non-empty steps array`);
    }
    for (const step of workflow.steps) {
      if (!step.id) throw new Error(`workflow "${id}" has a step without an id`);
      if (!step.agent && !step.capability) {
        throw new Error(`workflow "${id}" step "${step.id}" needs either agent or capability`);
      }
      if (step.agent && !config.agents[step.agent]) {
        throw new Error(`workflow "${id}" step "${step.id}" references unknown agent "${step.agent}"`);
      }
      if (!step.agent && step.capability) {
        const capable = Object.values(config.agents).some((agent) => agent.capabilities.includes(step.capability!));
        if (!capable) {
          throw new Error(`workflow "${id}" step "${step.id}" wants capability "${step.capability}" but no agent declares it`);
        }
      }
    }
    orderSteps(workflow);
  }
  return config;
}

export function getWorkflow(config: MeshConfig, name: string): WorkflowConfig {
  const workflow = config.workflows[name];
  if (!workflow) {
    throw new Error(`unknown workflow "${name}". Available: ${Object.keys(config.workflows).join(", ")}`);
  }
  return workflow;
}

export function resolveStepAgents(config: MeshConfig, step: StepConfig): string[] {
  if (step.agent) return [step.agent];
  const capability = step.capability;
  if (!capability) throw new Error(`step "${step.id}" needs either agent or capability`);
  const ids = Object.entries(config.agents)
    .filter(([, agent]) => agent.capabilities.includes(capability))
    .map(([id]) => id);
  if (ids.length === 0) throw new Error(`no agent provides capability "${capability}" for step "${step.id}"`);
  return ids;
}

export function getAgent(config: MeshConfig, id: string): AgentConfig {
  const agent = config.agents[id];
  if (!agent) throw new Error(`unknown agent "${id}"`);
  return agent;
}

export function orderSteps(workflow: WorkflowConfig): StepConfig[] {
  const byId = new Map(workflow.steps.map((step) => [step.id, step]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const step of workflow.steps) {
    indegree.set(step.id, 0);
    outgoing.set(step.id, []);
  }
  for (const step of workflow.steps) {
    for (const need of step.needs ?? []) {
      if (!byId.has(need)) throw new Error(`step "${step.id}" needs unknown step "${need}"`);
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      outgoing.get(need)?.push(step.id);
    }
  }
  const ready = workflow.steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((step) => step.id);
  const ordered: StepConfig[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const next of outgoing.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (ordered.length !== workflow.steps.length) {
    throw new Error("workflow has a dependency cycle");
  }
  return ordered;
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}

export function readStepPrompt(workspace: string, step: StepConfig): string {
  if (step.prompt) return step.prompt;
  if (step.promptFile) {
    const local = join(resolve(workspace), step.promptFile);
    const fallback = join(packageRoot, step.promptFile);
    const path = existsSync(local) ? local : fallback;
    if (!existsSync(path)) throw new Error(`prompt file not found: ${step.promptFile}`);
    return readFileSync(path, "utf8");
  }
  return "Complete the task described in the goal. Work directly in the workspace.";
}

export interface Invocation {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  env: Record<string, string>;
}

export function buildInvocation(
  agentId: string,
  agent: AgentConfig,
  prompt: string,
  workspace: string,
  vars: Record<string, string>,
): Invocation {
  const mergedVars: Record<string, string> = { ...vars, prompt, workspace };
  const args = (agent.args ?? []).map((arg) => interpolate(arg, mergedVars));

  if (agent.prompt === "arg") {
    args.push(prompt);
  } else if (agent.prompt === "arg-template") {
    const hasPlaceholder = (agent.args ?? []).some((arg) => arg.includes("{{prompt}}"));
    if (!hasPlaceholder) {
      throw new Error(`agent "${agentId}" uses prompt mode arg-template but no argument contains {{prompt}}`);
    }
  } else if (agent.prompt === "stdin") {
    // Prompt is delivered on stdin.
  } else if (agent.prompt === "none") {
    // No prompt is delivered.
  }

  return {
    command: interpolate(agent.command, mergedVars),
    args,
    stdin: agent.prompt === "stdin" ? prompt : "",
    timeoutMs: Math.max(1, agent.timeoutSec ?? 1800) * 1000,
    env: agent.env ?? {},
  };
}

export function dryRunConfig(config: MeshConfig): MeshConfig {
  const mock = join(packageRoot, "fixtures", "mock-agent.mjs");
  const agents: Record<string, AgentConfig> = {};
  for (const id of Object.keys(config.agents)) {
    agents[id] = {
      command: process.execPath,
      args: [mock],
      capabilities: config.agents[id].capabilities,
      prompt: "arg",
      timeoutSec: 30,
    };
  }
  return { ...config, agents };
}
