#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const prompt = process.argv[2] ?? readFileSync(0, "utf8");
const firstLine = prompt.split("\n").find((line) => line.trim().length > 0) ?? "empty prompt";

if (process.env.MESH_MOCK_FAIL === "1") {
  console.error("mock failure requested");
  process.exit(1);
}

writeFileSync("mesh-mock-change.txt", `mock agent touched this file\n${firstLine}\n`, "utf8");

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({ type: "system", subtype: "init", model: "mock" });
emit({
  type: "assistant",
  message: {
    content: [{ type: "text", text: `mock agent received: ${firstLine}` }],
  },
});
emit({ type: "result", result: "mock agent completed" });
