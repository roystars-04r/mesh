import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, AgentResult } from "./types.ts";
import type { Invocation } from "./config.ts";
import { nowIso, stripAnsi } from "./util.ts";

const TEXT_KEYS = ["text", "result", "response", "output_text", "agent_message", "summary", "content", "message"];

function extractText(value: unknown, depth = 0): string[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => extractText(item, depth + 1));
  if (typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const out: string[] = [];
  for (const key of TEXT_KEYS) {
    if (key in obj) out.push(...extractText(obj[key], depth + 1));
  }
  return out;
}

export function normalizeEvent(obj: Record<string, unknown>): AgentEvent {
  const type = String(obj.type ?? obj.event ?? obj.kind ?? "event");
  let text = "";

  if (type === "assistant") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      text = content
        .map((block) => {
          if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
            return String((block as Record<string, unknown>).text ?? "");
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  } else if (type === "step_update") {
    const update = obj.step_update as Record<string, unknown> | undefined;
    if (update && typeof update.text_delta === "string") text = update.text_delta;
  } else if (type === "result") {
    const result = obj.result;
    if (typeof result === "string") {
      text = result;
    } else if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      text = String(record.response ?? record.result ?? record.output ?? "");
    }
  } else if (type === "item.completed") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message") text = String(item.text ?? item.message ?? "");
  }

  if (!text) {
    text = extractText(obj).filter((part) => part.trim().length > 0).join("\n");
  }

  return { type, text: text || undefined, raw: obj, at: nowIso() };
}

export interface RunAgentOptions {
  invocation: Invocation;
  workspace: string;
  onEvent?: (event: AgentEvent) => void;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { invocation, workspace, onEvent } = options;
  const events: AgentEvent[] = [];
  const assistantTexts: string[] = [];
  let resultText = "";
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: workspace,
        env: { ...process.env, ...invocation.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        exitCode: 127,
        finalText: "",
        events: [],
        stdout: "",
        stderr: String(error),
        timedOut: false,
      });
      return;
    }

    const finish = (exitCode: number) => {
      resolve({
        exitCode,
        finalText: resultText || assistantTexts.at(-1) || lastText(events) || stripAnsi(stdout).trim(),
        events,
        stdout,
        stderr,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
    }, invocation.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      stderr += `\nspawn error: ${String(error)}`;
      finish(127);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });

    try {
      if (invocation.stdin) child.stdin.write(invocation.stdin);
      child.stdin.end();
    } catch {
      // The spawn error handler reports the real failure.
    }

    if (!child.stdout || !child.stderr) {
      finish(127);
      return;
    }

    const out = createInterface({ input: child.stdout });
    out.on("line", (line) => {
      stdout += `${line}\n`;
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: AgentEvent;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        event = normalizeEvent(parsed);
      } catch {
        event = { type: "text", text: trimmed, at: nowIso() };
      }
      events.push(event);
      if (event.type === "assistant" && event.text) assistantTexts.push(event.text);
      if (event.type === "result" && event.text) resultText = event.text;
      onEvent?.(event);
    });

    const err = createInterface({ input: child.stderr });
    err.on("line", (line) => {
      stderr += `${line}\n`;
    });
  });
}

function lastText(events: AgentEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const text = events[index].text;
    if (text) return text;
  }
  return "";
}
