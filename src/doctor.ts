import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, configPath } from "./config.ts";
import { runCommand } from "./util.ts";

function geminiAuthStatus(): { ok: boolean; detail: string } {
  const credentials = join(homedir(), ".gemini", "oauth_creds.json");
  if (existsSync(credentials)) {
    try {
      const parsed = JSON.parse(readFileSync(credentials, "utf8")) as Record<string, unknown>;
      const hasRefresh = typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0;
      const hasAccess = typeof parsed.access_token === "string" && parsed.access_token.length > 0;
      const expiry = typeof parsed.expiry_date === "number" ? parsed.expiry_date : null;
      if (hasRefresh || hasAccess) {
        const expired = expiry !== null && expiry < Date.now();
        const expiryText = expiry === null ? "" : `; access token ${expired ? "expired" : "valid until"} ${new Date(expiry).toISOString().slice(0, 16).replace("T", " ")} UTC`;
        return {
          ok: true,
          detail: `credentials present (${hasRefresh ? "refresh token" : "access token only"}${expiryText})`,
        };
      }
    } catch {
      return { ok: false, detail: "oauth_creds.json is unreadable" };
    }
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return { ok: true, detail: "API key present in environment" };
  }
  return { ok: false, detail: "not logged in; run `gemini` and choose Login with Google" };
}

export interface DoctorRow {
  name: string;
  ok: boolean;
  detail: string;
}

export function doctor(workspace: string): DoctorRow[] {
  const root = resolve(workspace);
  const rows: DoctorRow[] = [];
  rows.push({
    name: "node",
    ok: Number(process.versions.node.split(".")[0]) >= 24,
    detail: process.version,
  });
  const git = runCommand("git", ["--version"], root, 5_000);
  rows.push({
    name: "git",
    ok: git.status === 0,
    detail: git.status === 0 ? git.stdout.trim() : git.stderr.trim() || "not found",
  });
  rows.push({
    name: "mesh.json",
    ok: existsSync(configPath(root)),
    detail: existsSync(configPath(root)) ? configPath(root) : `missing at ${configPath(root)}`,
  });
  rows.push({
    name: ".mesh",
    ok: existsSync(join(root, ".mesh")) || true,
    detail: "run data is stored under .mesh/ (created on first run)",
  });

  let config;
  try {
    config = loadConfig(root);
  } catch (error) {
    rows.push({ name: "config", ok: false, detail: String(error instanceof Error ? error.message : error) });
    return rows;
  }

  if (config.agents.gemini) {
    const auth = geminiAuthStatus();
    rows.push({ name: "gemini-login", ok: auth.ok, detail: auth.detail });
  }

  for (const [id, agent] of Object.entries(config.agents)) {
    const result = runCommand(agent.command, agent.versionArgs ?? ["--version"], root, agent.versionArgs ? 60_000 : 15_000);
    const output = `${result.stdout}\n${result.stderr}`.trim().split("\n")[0] ?? "";
    const ok = result.status === 0;
    rows.push({
      name: id,
      ok,
      detail: ok ? `${agent.command}  ${output}` : `${agent.command} failed: ${output || "no output"}`,
    });
  }
  return rows;
}

export function printDoctor(rows: DoctorRow[]): void {
  const width = Math.max(...rows.map((row) => row.name.length), 8);
  for (const row of rows) {
    console.log(`${row.ok ? "✓" : "✗"} ${row.name.padEnd(width)}  ${row.detail}`);
  }
  const failed = rows.filter((row) => !row.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed. Install the missing CLI or fix mesh.json.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed.");
  }
}
