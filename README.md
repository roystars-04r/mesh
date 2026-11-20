**English** | [简体中文](README.zh-CN.md)

# Mesh

Mesh is a local orchestrator for coding agents you already have installed. It routes a goal through a small workflow, gives each agent a clean workspace, and passes structured artifacts between steps.

It is **not** a marketplace, a chat room, or a new agent runtime. The agents stay Claude Code, Codex, Antigravity CLI, and DSH; Mesh decides who does what and keeps the handoff inspectable.

```
goal ──► implement (Claude Code) ──► review (Codex) ──► verify (DSH, optional)
              │                         │
              └── diff + summary ───────┘
```

## Why

Each CLI is strong at different work:

| Agent | Best at | Adapter |
|---|---|---|
| Claude Code | implementation, refactors, frontend, long tasks | `claude -p --output-format stream-json` |
| Codex | review, debugging, tests, backend | `codex exec --json --sandbox workspace-write --skip-git-repo-check` |
| Antigravity | research, long context, docs, multimodal | `agy -p --output-format stream-json --mode accept-edits` |
| DSH | verification, tool use, execution | `npm exec --yes --package=@deepseek-ai/dsh -- dsh headless --json` |

Mesh uses those strengths in sequence instead of asking one agent to do everything.

## Requirements

- Node.js 24+ (Mesh uses native TypeScript execution and `node:sqlite`)
- At least one agent CLI on `PATH`
- Git (optional, but recommended; it enables isolated worktrees and cleaner diffs)

Checked locally with: `claude 2.1.325`, `codex 0.164.0`, `agy 1.5.5`, `dsh 0.2.2-rc.1`.

## Quick start

```bash
cd /path/to/your/project
node /path/to/mesh/src/cli.ts init      # creates mesh.json and prompts/
node /path/to/mesh/src/cli.ts doctor
node /path/to/mesh/src/cli.ts run "Add cursor pagination to /api/items"
```

For convenience, link it once:

```bash
cd /path/to/mesh
npm link
mesh doctor
```

`mesh run` is synchronous and prints step progress. Use `--verbose` to stream agent text.

### Try it without spending tokens

```bash
mesh run "smoke test" --dry-run --verbose
```

Every agent is replaced by `test/fixtures/mock-agent.mjs`. This exercises workspace preparation, prompt rendering, event capture, diffs, and SQLite persistence without calling a model.

## Commands

```text
mesh doctor                         Check Node, git, config, and agent CLIs
mesh agents                         List configured agents and capabilities
mesh run <goal> [options]           Run a workflow
mesh status [run_id]                Show a run or recent runs
mesh logs <run_id> [--step id]      Print the event log
mesh mcp                            Start the MCP server on stdio
mesh init                           Create mesh.json and prompts/ if missing
```

Run options:

```text
--workflow <name>    Workflow name (default: implement-review)
--workspace <path>   Workspace to operate on (default: current directory)
--run-id <id>        Reuse a run id
--dry-run            Replace agents with the local mock
--verbose            Stream agent text
--quiet              Only errors and the final summary
--json               Machine-readable result
```

## Workflows

The default `implement-review`:

1. **implement** — Claude Code edits the workspace.
2. **review** — Codex inspects the workspace and the diff, and reports findings by severity.

`implement-review-verify` adds a DSH verification step that runs tests/build commands and reports failures.

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

Steps form a DAG via `needs`. P0 executes steps sequentially in dependency order; the data model is ready for parallel branches.

## Prompt variables

Prompt files support:

| Variable | Value |
|---|---|
| `{{goal}}` | The user's goal |
| `{{workspace}}` | The run's isolated workspace |
| `{{run_id}}` | Run id |
| `{{step_id}}` | Step id |
| `{{diff}}` | Current diff (empty until a step changes files) |
| `{{source_root}}` | Original project directory |

## How a run works

1. Mesh loads `mesh.json`, validates the workflow, and creates `.mesh/runs/<run_id>/`.
2. It prepares an isolated workspace:
   - if the project is a git repo **and** `mesh.json` is committed, it creates a detached worktree from `HEAD`;
   - otherwise it copies the project, excluding `.mesh/`, `.git/`, and `node_modules/`.
3. Each step gets a rendered prompt at `.mesh/runs/<run_id>/prompts/<step>.md`.
4. Agent stdout is parsed as NDJSON when possible and stored in `.mesh/mesh.db` and `events.ndjson`.
5. The final text, raw events, stderr, and a diff are stored under `.mesh/runs/<run_id>/`.
6. Mesh never commits, pushes, deploys, or deletes the original workspace.

Artifacts:

```
.mesh/runs/<run_id>/
  brief.md
  prompts/<step>.md
  steps/<step>.md
  artifacts/diff-<step>.patch
  events.ndjson
  workspace/
```

The control plane lives in `.mesh/mesh.db` (SQLite, WAL mode). Add `.mesh/` to `.gitignore`. If you delete `.mesh/` while worktree runs exist, also run `git worktree prune`.

## MCP

`mesh mcp` speaks JSON-RPC over stdio and exposes:

| Tool | Purpose |
|---|---|
| `mesh_run` | Start a workflow in the background; returns a run id |
| `mesh_status` | Show a run, steps, and artifacts |
| `mesh_agents` | List configured agents |
| `mesh_artifacts` | List a run's artifacts |

Register it with Claude Code:

```bash
claude mcp add mesh -- node /path/to/mesh/src/cli.ts mcp
```

For Codex, add a stdio MCP server entry pointing at the same command. For Antigravity, add a stdio MCP server through `agy mcp add` with the same `node .../src/cli.ts mcp` command.

This lets an agent delegate a scoped job to another agent without leaving its own session:

```
Use mesh_run with goal "fix the failing pagination test", then poll mesh_status.
```

## Configuration

`mesh.json` has two top-level objects: `agents` and `workflows`.

Gemini Code Assist for individuals is no longer supported by Google. Mesh therefore uses Antigravity (`agy`), the migration path Google names. If you have a Gemini API key, you can add a `gemini` agent back manually with `GEMINI_API_KEY` in its environment.

`dsh` is launched through npm (`npm exec --yes --package=@deepseek-ai/dsh -- dsh`) so it works even when the package is only installed in the npm/npx cache. Set `versionArgs` when the CLI's version flag is not a plain `--version`, as the DSH entry does.

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
- `none` — no prompt.

`args` also supports `{{workspace}}`, `{{goal}}`, `{{run_id}}`, and `{{step_id}}`.

### Workflow step

```json
{
  "id": "review",
  "agent": "codex",
  "needs": ["implement"],
  "promptFile": "prompts/review.md"
}
```

`prompt` can be used instead of `promptFile` for small workflows.

## Safety defaults

- Local only; no server, no telemetry, no cloud calls from Mesh itself.
- Agents run in a copied workspace or a detached worktree, never the original.
- No `--dangerously-skip-permissions` or equivalent in the default config.
- Prompts tell agents not to commit, push, deploy, or print secrets.
- The CLI has no destructive commands; deleting `.mesh/` is left to the user.
- Agent CLIs may still ask for approval or need authentication. Mesh does not bypass their permission systems.

If a CLI blocks on an interactive prompt, run its one-time login/trust flow first, then re-run Mesh with `--verbose` to see where it stopped.

Codex needs a writable `CODEX_HOME` (usually `~/.codex`). In a heavily sandboxed agent environment it may fail with `failed to initialize in-process app-server client: Operation not permitted`; run Mesh from a normal terminal or point `CODEX_HOME` at a writable profile.

## Current limitations

- P0 runs steps sequentially; parallel branches are not scheduled yet.
- Token/cost accounting is not implemented.
- Approval gates are prompt-level, not cryptographic.
- The MCP `mesh_run` is fire-and-forget; poll `mesh_status`.
- Agent output formats differ; Mesh extracts text heuristically and always keeps raw stdout/stderr.
- The `dsh` adapter assumes `dsh headless` is configured and authenticated in the current environment. Set `DSH_HOME` in `mesh.json` `env` if you use a non-default profile.

## Development

```bash
node --test test/*.test.ts
node src/cli.ts doctor
node src/cli.ts run "smoke test" --dry-run --verbose
```

No build step and no runtime npm dependencies. TypeScript is executed directly by Node 24; `tsconfig.json` is for editors/type checking.

## Roadmap

- Parallel DAG execution and per-step worktrees
- Capability-based routing and fallback (`coding` → Claude, `review` → Codex)
- Token/cost budgets and per-run limits
- Interactive approval gate for destructive steps
- More workflows: `research-implement-review`, `debug-fix-verify`
- Web dashboard over `.mesh/mesh.db`
