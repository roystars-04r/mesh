# Mesh

**English** | [简体中文](README.md)

Mesh is a local orchestrator for the coding agents you already have installed. It splits a goal into a small workflow, gives each agent a clean workspace, and passes structured artifacts between steps.

It is **not** a task marketplace, a chat room, or another agent runtime. Claude Code, Codex, Antigravity CLI, and DSH still do the work; Mesh decides who does which step and makes the handoffs inspectable.

```
goal ──► implement (Claude Code) ──► review (Codex) ──► verify (DSH, optional)
              │                         │
              └── diff + summary ───────┘
```

## Why

Each CLI is good at different things:

| Agent | Strength | Adapter |
|---|---|---|
| Claude Code | implementation, refactors, frontend, long tasks | `claude -p --output-format stream-json` |
| Codex | review, debugging, tests, backend | `codex exec --json --sandbox workspace-write --skip-git-repo-check` |
| Antigravity | research, long context, docs, multimodal | `agy -p --output-format stream-json --mode accept-edits` |
| DSH | verification, tool use, execution | `npm exec --yes --package=@deepseek-ai/dsh -- dsh headless --json` |

Mesh uses those strengths in sequence instead of asking one agent to do everything.

## Requirements

- Node.js 24+ (Mesh runs TypeScript directly and uses built-in `node:sqlite`)
- At least one agent CLI on `PATH`
- Git (optional but recommended: isolated worktrees, parallel branches, cleaner diffs)

Versions verified locally: `claude 2.1.325`, `codex 0.164.0`, `agy 1.5.5`, `dsh 0.2.2-rc.1`.

## Quick start

```bash
cd /path/to/your/project
node /path/to/mesh/src/cli.ts init      # creates mesh.json and prompts/
node /path/to/mesh/src/cli.ts doctor
node /path/to/mesh/src/cli.ts run "add cursor pagination to /api/items"
node /path/to/mesh/src/cli.ts apply <run_id>   # apply the diff when you are happy
```

To avoid typing the path, link once:

```bash
cd /path/to/mesh
npm link
mesh doctor
```

`mesh run` runs synchronously and prints per-step progress. Add `--verbose` to stream agent text live. Mesh never applies changes to your original workspace by itself; `mesh apply` does that explicitly.

### A free smoke test

```bash
mesh run "smoke test" --dry-run --verbose
```

`--dry-run` swaps every agent for `test/fixtures/mock-agent.mjs`. It still exercises workspace preparation, prompt rendering, event capture, diffs, and SQLite persistence, but makes no model calls.

## Commands

```text
mesh doctor                        Check Node, git, config, and agent CLIs
mesh agents                        List configured agents and capabilities
mesh run <goal> [options]          Run a workflow
mesh retry <run_id> [options]      Rerun failed steps, reusing completed ones
mesh cancel <run_id>               Cancel a running or queued run
mesh apply <run_id> [--step id]    Apply a run's diff to the workspace
mesh status [run_id]               Show one run or recent runs
mesh logs <run_id> [--step id]     Print the event log
mesh stats [--json]                Aggregate counts, durations, and cost
mesh clean [options]               Delete old runs and prune worktrees
mesh mcp                           Start the MCP server on stdio
mesh web [options]                 Open the local dashboard
mesh init                          Create mesh.json and prompts/ when missing
```

`status`, `logs`, `cancel`, `apply`, `clean`, and `stats` all accept `--workspace <path>` (default: current directory).

Options for `run` / `retry`:

```text
--workflow <name>    Workflow from mesh.json (default: implement-review)
--workspace <path>   Workspace to operate on (default: current directory)
--run-id <id>        Continue an existing run id
--resume             With --run-id: reuse completed steps, rerun failed/cancelled ones
--retry <n>          Retry each failed step up to n times (default: 0)
--max-cost <usd>     Stop before the next step once the run exceeds this cost
--yes                Auto-approve steps marked approve: true
--notify <url>       POST a JSON summary to this webhook when the run ends
--dry-run            Replace every agent with the local mock
--verbose            Stream agent text to stdout
--quiet              Only errors and the final summary
--json               Print a machine-readable result
```

Exit codes: `0` success, `1` failure, `130` cancelled.

## Workflows

The default `implement-review`:

1. **implement** — Claude Code changes the workspace.
2. **review** — Codex inspects the workspace and diff and reports issues by severity.

`implement-review-verify` appends a DSH verification step that runs tests/builds and reports failures.

Two more built-in workflows:

- `research-implement-review` — research first (Antigravity's `research` capability by default), then implement, then review.
- `debug-fix-verify` — Codex finds the root cause, Claude makes the smallest fix, DSH reruns the tests.

Workflows are data in `mesh.json`:

```json
{
  "workflows": {
    "implement-review": {
      "steps": [
        { "id": "implement", "agent": "claude", "promptFile": "prompts/implement.md" },
        { "id": "review", "agent": "codex", "needs": ["implement"], "promptFile": "prompts/review.md" }
      ]
    }
  }
}
```

Steps form a DAG through `needs`. Steps that are ready at the same time and do not depend on each other run in parallel in per-step git worktrees, then merge back into the run workspace in order. Outside git, they fall back to serial execution and emit a `run.warning` event.

A step can name an `agent`, or route by `capability`:

```json
{ "id": "review", "capability": "review", "needs": ["implement"] }
```

Capability routing picks candidates in `mesh.json` declaration order. It only falls back to the next candidate on spawn failure (for example the CLI is missing); a real agent failure is recorded as a failure rather than silently rerouted.

## Prompt variables

| Variable | Meaning |
|---|---|
| `{{goal}}` | The user's goal |
| `{{workspace}}` | This run's isolated workspace |
| `{{run_id}}` | Run id |
| `{{step_id}}` | Step id |
| `{{diff}}` | Current diff (empty before a step edits files) |
| `{{previous}}` | Summaries of completed steps (in completion order, 8000 chars each) |
| `{{source_root}}` | Original project directory |

`{{previous}}` lets a research or diagnosis step hand its findings to the next step without writing intermediate files into the project.

## What happens during a run

1. Mesh reads `mesh.json`, validates the workflow, and creates `.mesh/runs/<run_id>/`.
2. It prepares an isolated workspace:
   - if the project is a git repository **and** `mesh.json` is committed, a detached worktree from `HEAD`;
   - otherwise a copy of the project excluding `.mesh/`, `.git/`, and `node_modules/`.
3. Rendered prompts are written to `.mesh/runs/<run_id>/prompts/<step>.md`.
4. Agent stdout is parsed as NDJSON when possible and stored in `.mesh/mesh.db` and `events.ndjson`.
5. Final text, raw events, stderr, diffs, and token/cost usage stay under `.mesh/runs/<run_id>/`.
6. When the run ends, a configured webhook receives a JSON summary; runs started from MCP or the web UI also get a queued record.
7. Mesh never commits, pushes, deploys, or deletes the original workspace. Applying results back is an explicit `mesh apply`.

Artifacts:

```
.mesh/runs/<run_id>/
  brief.md
  summary.md
  prompts/<step>.md
  steps/<step>.md
  artifacts/diff-<step>.patch
  events.ndjson
  workspace/
```

Control-plane data lives in `.mesh/mesh.db` (SQLite, WAL). Add `.mesh/` to `.gitignore`. If you delete `.mesh/` while worktree runs still exist, run `git worktree prune` afterwards; `mesh clean` does it automatically.

## Cancel, resume, retry

```bash
mesh cancel <run_id>      # a running runner sees the CANCEL marker on its next poll and aborts
mesh retry <run_id>       # reuse completed steps, rerun failed/cancelled ones
mesh run "..." --run-id <id> --resume
```

- Cancellation uses a `<run_dir>/CANCEL` marker polled every 500ms. The current agent gets `SIGTERM`, then `SIGKILL` after 3 seconds.
- `Ctrl+C` follows the same path: the first interrupt stops the current step, the second exits immediately (130).
- Runs whose process died but still say `running` are flipped to `cancelled` on the next start or `mesh cancel`.
- Resuming continues from the latest diff; completed steps are marked `skipped`, so they do not spend tokens again.

## Budgets and approvals

Set a budget at the top level of `mesh.json`:

```json
{ "budget": { "maxCostUsd": 2.5, "maxInputTokens": 200000, "maxOutputTokens": 60000 } }
```

`--max-cost` overrides the per-run cost cap. Usage is extracted from agent events (Claude stream-json, Codex `--json`, DSH `headless --json`) and checked after each step; when exceeded, no further step starts and the run is marked failed. If an agent reports no usage, Mesh writes a `run.warning`.

Gate a risky step:

```json
{ "id": "deploy", "agent": "claude", "approve": true, "promptFile": "prompts/deploy.md" }
```

On a TTY Mesh asks `[y/N]`. In non-interactive environments the step fails with `approval required; rerun with --yes` instead of silently proceeding.

## MCP

`mesh mcp` exposes a stdio JSON-RPC server with seven tools:

| Tool | Purpose |
|---|---|
| `mesh_run` | Start a workflow in the background, returns a run id |
| `mesh_status` | Show a run's steps and artifacts |
| `mesh_agents` | List configured agents |
| `mesh_artifacts` | List a run's artifacts |
| `mesh_logs` | Read the event log (optionally by step) |
| `mesh_cancel` | Cancel a run |
| `mesh_apply` | Check or apply a run's diff |

Register it in Claude Code:

```bash
claude mcp add mesh -- node /path/to/mesh/src/cli.ts mcp
```

Add a stdio MCP server pointing at the same command in Codex. For Antigravity, `agy mcp add` the same `node .../src/cli.ts mcp` command.

An agent can then delegate a bounded piece of work without leaving its session:

```
Start "fix the pagination test failure" with mesh_run, follow it with mesh_logs, then mesh_apply.
```

## Web dashboard

```bash
mesh web
# Mesh web: http://127.0.0.1:4317
```

The dashboard reads `.mesh/mesh.db` for the current workspace and can:

- start a run from a form (workflow, dry-run, cost cap);
- cancel a running run;
- follow progress over SSE (`/api/runs/:id/stream`) instead of polling;
- inspect step output, errors, token/cost usage, and diff artifact links.

```text
--port <number>     Listen port (default 4317)
--host <address>    Bind address (default 127.0.0.1)
--workspace <path>  Workspace to operate on (default current directory)
```

The dashboard binds to loopback only and has no authentication. POST endpoints reject cross-site `Origin`, require `application/json`, and cap bodies at 64KB. Do not expose it publicly. To switch projects, pass `--workspace` or `cd` into that project first.

## Configuration

Top-level keys in `mesh.json`: `agents`, `workflows`, and optional `budget` and `notify`.

```json
{ "notify": { "webhook": "https://example.com/mesh-hook" } }
```

Google has discontinued Gemini Code Assist for individuals, so Mesh defaults to Antigravity (`agy`), the migration path Google points to. If you have a Gemini API key you can add a `gemini` agent back manually and provide `GEMINI_API_KEY` in the environment.

`dsh` is launched through npm (`npm exec --yes --package=@deepseek-ai/dsh -- dsh`), so it also works when the package only exists in the npm/npx cache. If a CLI's version flag is not plain `--version`, override it with `versionArgs`; the DSH entry is an example.

### Agent

```json
{
  "command": "claude",
  "args": ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
  "capabilities": ["coding", "refactor"],
  "prompt": "arg",
  "timeoutSec": 1800,
  "env": {}
}
```

`prompt` modes:

- `arg` — append the prompt as the last argument.
- `stdin` — write the prompt to stdin.
- `arg-template` — substitute `{{prompt}}` inside `args`; useful for CLIs that need `-p "..."`.
- `none` — pass no prompt.

`args` also support `{{workspace}}`, `{{goal}}`, `{{run_id}}`, and `{{step_id}}`.

### Workflow steps

```json
{
  "id": "review",
  "agent": "codex",
  "needs": ["implement"],
  "promptFile": "prompts/review.md",
  "approve": false
}
```

Small workflows can use `prompt` instead of `promptFile`, and `capability` instead of `agent`.

## Safe defaults

- Local only. Mesh has no server, no telemetry, and does not send project data anywhere on its own.
- Agents run in a copied workspace or a detached worktree and never touch the original directory.
- The default configuration contains no `--dangerously-skip-permissions` style bypasses.
- Prompts ask agents not to commit, push, deploy, or print secrets.
- The only destructive CLI command is `mesh clean`; it keeps the 10 most recent runs by default and requires confirmation or `--yes`.
- Agent CLIs may still require approvals or login; Mesh does not bypass their own permission systems.

If a CLI hangs on an interactive prompt, run its login/trust flow once, then rerun Mesh with `--verbose` to see where it stops.

Codex needs a writable `CODEX_HOME` (usually `~/.codex`). In a heavily restricted sandbox it can fail with `failed to initialize in-process app-server client: Operation not permitted`; run Mesh from a normal terminal or point `CODEX_HOME` at a writable profile.

## Current limitations

- Parallel execution requires git worktree mode; copy mode still runs steps serially.
- Token/cost accounting depends on each agent's output format. When usage is missing Mesh can only warn, not bill precisely.
- Approvals are interactive confirmations, not cryptographic authorization.
- The web dashboard has no authentication and is meant for local use.
- Agent output formats differ; Mesh extracts text heuristically but always keeps raw stdout/stderr.
- The `dsh` adapter assumes `dsh headless` is configured and logged in. For a non-default profile, set `DSH_HOME` in the agent's `env`.

## Development

```bash
node --test test/*.test.ts
node src/cli.ts doctor
node src/cli.ts run "smoke test" --dry-run --verbose
```

No build step and no runtime npm dependencies. Node 24 executes the TypeScript directly; `tsconfig.json` is only for editors and type checking.

Tests cover config validation and DAG ordering, four agent event formats, SQLite persistence, worktree/diff, cancel, resume, approvals, budgets, parallel merges, capability fallback, apply, clean, stats, MCP tools, and web start/cancel/SSE.
