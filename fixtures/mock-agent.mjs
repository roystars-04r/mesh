#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const prompt = process.argv[2] ?? readFileSync(0, "utf8");
const firstLine = prompt.split("\n").find((line) => line.trim().length > 0) ?? "empty prompt";

const sleepMs = Number(process.env.MESH_MOCK_SLEEP ?? 0);
if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await new Promise((done) => setTimeout(done, sleepMs));
}

if (process.env.MESH_MOCK_FAIL === "1" || prompt.includes("[fail]")) {
  console.error("mock failure requested");
  process.exit(1);
}

// Tests can steer a parallel step to a distinct file so the branches merge cleanly.
const fileMatch = /\[file:([A-Za-z0-9_./-]+)\]/.exec(prompt);
const target = fileMatch ? fileMatch[1] : "mesh-mock-change.txt";

writeFileSync(target, `mock agent touched this file\n${firstLine}\n`, "utf8");

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({ type: "system", subtype: "init", model: "mock" });
emit({
  type: "assistant",
  message: {
    content: [{ type: "text", text: `mock agent received: ${firstLine}` }],
  },
});
const result = { type: "result", result: "mock agent completed" };
if (process.env.MESH_MOCK_USAGE === "1") {
  result.usage = { input_tokens: 1_000, output_tokens: 500 };
  result.total_cost_usd = 0.5;
}
emit(result);
