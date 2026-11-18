import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function newId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${random}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeText(path: string, text: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, text, "utf8");
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function truncate(text: string, max = 80_000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head}\n\n[truncated ${text.length - max} chars]`;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 15_000,
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : undefined,
  };
}

export function runCommandAsync(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

export function isGitRepo(cwd: string): boolean {
  if (!existsSync(join(cwd, ".git"))) {
    // Worktrees have a .git file, so also ask git.
  }
  const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd, 5_000);
  return result.status === 0 && result.stdout.trim() === "true";
}

export function git(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  return runCommand("git", args, cwd, 30_000);
}

export function hasGitHead(cwd: string): boolean {
  const result = git(["rev-parse", "--verify", "HEAD"], cwd);
  return result.status === 0;
}

export function relativeTo(root: string, path: string): string {
  if (!path.startsWith(root)) return path;
  return path.slice(root.length).replace(/^\/+/, "");
}

export function copyTree(source: string, target: string, skip: Set<string> = new Set([".mesh", ".git", "node_modules"])): void {
  ensureDir(target);
  for (const entry of readdirSync(source)) {
    if (skip.has(entry)) continue;
    const src = join(source, entry);
    const dst = join(target, entry);
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(src), dst);
    } else if (stat.isDirectory()) {
      copyTree(src, dst, skip);
    } else if (stat.isFile()) {
      copyFileSync(src, dst);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
