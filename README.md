# Mesh

[![CI](https://github.com/roystars-04r/mesh/actions/workflows/ci.yml/badge.svg)](https://github.com/roystars-04r/mesh/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)
[![npm version](https://img.shields.io/npm/v/mesh-orchestrator?color=cb3837&logo=npm&logoColor=white&style=flat)](https://www.npmjs.com/package/mesh-orchestrator) [![npm downloads](https://img.shields.io/npm/dm/mesh-orchestrator?color=cb3837&style=flat)](https://www.npmjs.com/package/mesh-orchestrator) [![node](https://img.shields.io/node/v/mesh-orchestrator?color=5fa04e&logo=node.js&logoColor=white&style=flat)](package.json) [![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat)](package.json) [![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat)](https://github.com/roystars-04r/mesh/pulls) [![GitHub stars](https://img.shields.io/github/stars/roystars-04r/mesh?style=flat)](https://github.com/roystars-04r/mesh/stargazers)

[![works with](https://img.shields.io/badge/works%20with-Claude%20Code%20%7C%20Codex%20%7C%20Antigravity%20%7C%20DSH-8A2BE2?style=flat)](#为什么需要它) [![install size](https://badgen.net/packagephobia/install/mesh-orchestrator?style=flat)](https://packagephobia.com/result?p=mesh-orchestrator) [![line coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/roystars-04r/mesh/main/badges/coverage.json&style=flat)](https://github.com/roystars-04r/mesh/actions/workflows/badges.yml) [![Socket](https://socket.dev/api/badge/npm/package/mesh-orchestrator?style=flat)](https://socket.dev/npm/package/mesh-orchestrator) [![works on my machine](https://forthebadge.com/images/badges/works-on-my-machine.svg)](https://forthebadge.com)

[English](README.en.md) | **简体中文**

Mesh 是一个本地编排器，用来调度你机器上已经装好的编码 Agent。它把一个目标拆成一个小型工作流，为每个 Agent 准备干净的工作区，并在步骤之间传递结构化产物。

它**不是**任务市场、聊天室，也不是新的 Agent 运行时。执行任务的仍然是 Claude Code、Codex、Antigravity CLI 和 DSH；Mesh 只决定谁来做哪一步，并让交接过程可检查。

```
目标 ──► 实现（Codex） ──► 审查（Claude Code） ──► 验证（DSH，可选）
              │                       │
              └── diff + 摘要 ────────┘
```

## 为什么需要它

每个 CLI 擅长的方向不同：

| Agent | 擅长 | 适配方式 |
|---|---|---|
| Claude Code | 实现、重构、前端、长任务 | `claude -p --output-format stream-json` |
| Codex | 审查、调试、测试、后端 | `codex exec --json --sandbox workspace-write --skip-git-repo-check` |
| Antigravity | 调研、长上下文、文档、多模态 | `agy -p --output-format stream-json --mode accept-edits` |
| DSH | 验证、工具调用、执行 | `npm exec --yes --package=@deepseek-ai/dsh -- dsh headless --json` |

Mesh 按顺序利用这些长处，而不是让一个 Agent 包办所有事情。

## 环境要求

- Node.js 24+（Mesh 直接运行 TypeScript，并使用内置的 `node:sqlite`）
- 至少一个 Agent CLI 在 `PATH` 中
- Git（可选，但推荐；有 Git 才能使用隔离 worktree、并行分支和更干净的 diff）

本机验证过的版本：`claude 2.1.325`、`codex 0.164.0`、`agy 1.5.5`、`dsh 0.2.2-rc.1`。

## 快速开始

```bash
npm install -g mesh-orchestrator

cd /path/to/your/project
mesh init      # 创建 mesh.json 和 prompts/
mesh doctor
mesh run "给 /api/items 加上游标分页"
```

也可以从源码运行：`node /path/to/mesh/src/cli.ts run ...`（开发时不用构建）。

`mesh run` 是同步执行的，会打印每一步的进度。加 `--verbose` 可以实时看到 Agent 的输出。运行结束后用 `mesh apply <run_id>` 把 diff 应用到原始工作区。

### 不花 token 试跑

```bash
mesh run "smoke test" --dry-run --verbose
```

`--dry-run` 会把所有 Agent 替换成 `test/fixtures/mock-agent.mjs`。它仍然会完整走一遍工作区准备、提示词渲染、事件捕获、diff 和 SQLite 持久化，但不会调用模型。

## 命令

```text
mesh doctor                        检查 Node、git、配置和 Agent CLI
mesh agents                        列出已配置的 Agent 和能力
mesh run <goal> [options]          运行一个工作流
mesh retry <run_id> [options]      重跑失败的步骤，复用已经完成的步骤
mesh cancel <run_id>               取消正在运行或排队的运行
mesh apply <run_id> [--step id]    把某次运行的 diff 应用到工作区
mesh status [run_id]               查看某次运行或最近几次运行
mesh logs <run_id> [--step id]     打印事件日志
mesh stats [--json]                汇总次数、耗时和成本
mesh clean [options]               删除旧运行并清理 worktree
mesh mcp                           在 stdio 上启动 MCP server
mesh web [options]                 打开本地面板
mesh init                          在缺失时创建 mesh.json 和 prompts/
```

`status`、`logs`、`cancel`、`apply`、`clean`、`stats` 都接受 `--workspace <path>`（默认当前目录）。

`run` / `retry` 的选项：

```text
--workflow <name>    工作流名称（默认：codex-implement-claude-review）
--workspace <path>   要操作的工作区（默认：当前目录）
--run-id <id>        继续一个已有 run id
--resume             配合 --run-id：复用已完成的步骤，只重跑失败/取消的步骤
--retry <n>          每个失败步骤最多重试 n 次（默认：0）
--max-cost <usd>     花到这个金额后不再开始下一步
--yes                自动批准标记了 approve 的步骤
--notify <url>       运行结束时向该 webhook POST 一份 JSON 摘要
--dry-run            用本地 mock 替代 Agent
--verbose            实时输出 Agent 文本
--quiet              只输出错误和最终摘要
--json               输出机器可读的结果
```

退出码：`0` 成功，`1` 失败，`130` 被取消。

## 工作流

默认的 `codex-implement-claude-review`：

1. **implement** — Codex 修改工作区。
2. **review** — Claude Code 检查工作区和 diff，按严重级别报告问题。

想要反过来（Claude 实现、Codex 审查），用 `--workflow implement-review`；`implement-review-verify` 会在审查后再加一个 DSH 验证步骤，运行测试/构建命令并报告失败。

另外两个内置工作流：

- `research-implement-review` — 先调研（默认走 Antigravity 的 `research` 能力），再实现，最后审查。
- `debug-fix-verify` — Codex 先定位根因，Claude 做最小修复，DSH 复跑测试验证。

工作流就是 `mesh.json` 里的数据：

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

步骤通过 `needs` 组成 DAG。彼此没有依赖、同时就绪的步骤，在 Git 模式下会各自跑在独立 worktree 里并行执行，完成后按顺序 merge 回运行工作区；不是 Git 仓库时退化为串行，并写入一条 `run.warning` 事件。

步骤可以写 `agent`（指定 Agent），也可以写 `capability`（按能力路由）：

```json
{ "id": "review", "capability": "review", "needs": ["implement"] }
```

能力路由会按 `mesh.json` 中 Agent 的声明顺序挑选候选。只有 spawn 失败（例如 CLI 没装）才回退到下一个候选；Agent 真的跑失败不会偷偷换人，会直接记为失败。

## 提示词变量

提示词文件支持：

| 变量 | 含义 |
|---|---|
| `{{goal}}` | 用户给出的目标 |
| `{{workspace}}` | 本次运行的隔离工作区 |
| `{{run_id}}` | 运行 id |
| `{{step_id}}` | 步骤 id |
| `{{diff}}` | 当前 diff（在步骤修改文件之前为空） |
| `{{previous}}` | 已完成步骤的输出摘要（按完成顺序，每段最多 8000 字符） |
| `{{source_root}}` | 原始项目目录 |

`{{previous}}` 让调研/诊断步骤的结论能传给后续步骤，而不用把中间文件塞进项目。

## 一次运行发生了什么

1. Mesh 读取 `mesh.json`，校验工作流，并创建 `.mesh/runs/<run_id>/`。
2. 准备隔离工作区：
   - 如果项目是 Git 仓库，**并且** `mesh.json` 已经提交，就从 `HEAD` 创建一个 detached worktree；
   - 否则复制一份项目，排除 `.mesh/`、`.git/` 和 `node_modules/`。
3. 每一步的提示词渲染后写到 `.mesh/runs/<run_id>/prompts/<step>.md`。
4. Agent 的 stdout 会尽量按 NDJSON 解析，并写入 `.mesh/mesh.db` 和 `events.ndjson`。
5. 最终文本、原始事件、stderr、diff 和 token/成本都保存在 `.mesh/runs/<run_id>/` 下。
6. 运行结束时如果配置了 webhook，会 POST 一份摘要；MCP 和 Web 启动的运行还会有一条排队记录。
7. Mesh 不会 commit、push、deploy，也不会删除原始工作区；把结果应用回去需要显式执行 `mesh apply`。

产物结构：

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

控制面数据在 `.mesh/mesh.db`（SQLite，WAL 模式）。记得把 `.mesh/` 加进 `.gitignore`。如果删除 `.mesh/` 时还有 worktree 运行记录，之后执行一次 `git worktree prune`；`mesh clean` 会自动做这件事。

## 取消、恢复与重试

```bash
mesh cancel <run_id>      # 运行中的进程会在下次轮询时收到 CANCEL 标记并中止
mesh retry <run_id>       # 复用已完成步骤，重跑失败/取消的步骤
mesh run "..." --run-id <id> --resume
```

- 取消通过 `<run_dir>/CANCEL` 标记 + 500ms 轮询实现，当前 Agent 会先收到 `SIGTERM`，3 秒后仍未退出则 `SIGKILL`。
- `Ctrl+C` 走同一条路径：第一次中断当前步骤，第二次强制退出（130）。
- 进程已经死掉但状态仍是 `running` 的运行，会在下一次启动或 `mesh cancel` 时被标记为 `cancelled`。
- 恢复运行会从最后一次 diff 继续，已完成步骤标记为 `skipped`，不会重复花 token。

## 预算与审批

在 `mesh.json` 顶层加预算：

```json
{ "budget": { "maxCostUsd": 2.5, "maxInputTokens": 200000, "maxOutputTokens": 60000 } }
```

也可以用 `--max-cost` 覆盖单次运行的成本上限。用量从 Agent 的事件里尽力提取（Claude stream-json、Codex `--json`、DSH `headless --json`），在每步结束后检查；超限时不再开始下一步，运行标记为失败。Agent 不上报用量时会写一条 `run.warning`。

给危险步骤加审批门：

```json
{ "id": "deploy", "agent": "claude", "approve": true, "promptFile": "prompts/deploy.md" }
```

在 TTY 下会询问 `[y/N]`；非交互环境直接失败并提示 `approval required; rerun with --yes`，不会默默放行。

## MCP

`mesh mcp` 通过 stdio 提供 JSON-RPC 接口，暴露七个工具：

| 工具 | 用途 |
|---|---|
| `mesh_run` | 在后台启动一个工作流，返回 run id |
| `mesh_status` | 查看某次运行的步骤和产物 |
| `mesh_agents` | 列出已配置的 Agent |
| `mesh_artifacts` | 列出某次运行的产物 |
| `mesh_logs` | 读取事件日志（可按步骤过滤） |
| `mesh_cancel` | 取消一次运行 |
| `mesh_apply` | 检查或应用某次运行的 diff |

在 Claude Code 中注册：

```bash
claude mcp add mesh -- node /path/to/mesh/src/cli.ts mcp
```

Codex 添加一个指向同一命令的 stdio MCP server 即可。Antigravity 可以用 `agy mcp add` 添加同一个 `node .../src/cli.ts mcp` 命令。

这样 Agent 不用离开自己的会话，就能把一段有边界的工作委派出去：

```
用 mesh_run 启动目标“修复分页测试失败”，用 mesh_logs 跟进度，结束后 mesh_apply。
```

## Web 面板

```bash
mesh web
# Mesh web: http://127.0.0.1:4317
```

面板读取当前工作区的 `.mesh/mesh.db`，并且可以：

- 从表单直接启动运行（选工作流、dry-run、成本上限）；
- 取消运行中的任务；
- 通过 SSE（`/api/runs/:id/stream`）实时接收步骤和产物变化，不用轮询；
- 查看步骤输出、错误、token/成本和 diff 产物链接。

```text
--port <number>     监听端口（默认 4317）
--host <address>    绑定地址（默认 127.0.0.1）
--workspace <path>  要操作的工作区（默认当前目录）
```

面板默认只绑定回环地址，没有登录。POST 接口会拒绝跨站 `Origin`、要求 `application/json`，请求体上限 64KB；不要把它直接暴露到公网。要换项目，用 `--workspace` 指过去，或者先 `cd` 到那个项目再启动。

## 配置

`mesh.json` 顶层对象：`agents`、`workflows`，可选 `budget` 和 `notify`。

```json
{ "notify": { "webhook": "https://example.com/mesh-hook" } }
```

Google 已经停止支持面向个人的 Gemini Code Assist，因此 Mesh 默认使用 Antigravity（`agy`），这也是 Google 指定的迁移路径。如果你有 Gemini API key，可以手动把 `gemini` Agent 加回来，并在环境中提供 `GEMINI_API_KEY`。

`dsh` 通过 npm 启动（`npm exec --yes --package=@deepseek-ai/dsh -- dsh`），所以即使包只存在于 npm/npx 缓存里也能用。如果某个 CLI 的版本参数不是普通的 `--version`，用 `versionArgs` 覆盖，DSH 的配置就是例子。

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

`prompt` 的模式：

- `arg` — 把提示词作为最后一个参数追加。
- `stdin` — 把提示词写入 stdin。
- `arg-template` — 替换 `args` 里的 `{{prompt}}`；适合必须写 `-p "..."` 的 CLI。
- `none` — 不传提示词。

`args` 里也支持 `{{workspace}}`、`{{goal}}`、`{{run_id}}` 和 `{{step_id}}`。

### 工作流步骤

```json
{
  "id": "review",
  "agent": "codex",
  "needs": ["implement"],
  "promptFile": "prompts/review.md",
  "approve": false
}
```

小工作流可以直接用 `prompt` 代替 `promptFile`；用 `capability` 代替 `agent` 可以按能力路由。

## 安全默认值

- 纯本地；Mesh 本身没有服务器、没有遥测、不主动上云。
- Agent 在复制的工作区或 detached worktree 里运行，永远不直接动原始目录。
- 默认配置里没有 `--dangerously-skip-permissions` 之类的绕过参数。
- 提示词会要求 Agent 不 commit、不 push、不 deploy、不打印密钥。
- CLI 的删除操作只有 `mesh clean`，默认保留最近 10 次运行，并且需要确认或 `--yes`。
- Agent CLI 仍可能要求审批或登录；Mesh 不会绕过它们自己的权限系统。

如果某个 CLI 卡在交互式提示上，先单独跑一次它的登录/信任流程，再用 `--verbose` 重跑 Mesh，看它停在哪一步。

Codex 需要可写的 `CODEX_HOME`（通常是 `~/.codex`）。在限制很严的沙箱里，它可能报 `failed to initialize in-process app-server client: Operation not permitted`；换到普通终端运行 Mesh，或把 `CODEX_HOME` 指向一个可写的 profile。

## 当前限制

- 并行执行只在 Git worktree 模式下启用；复制模式仍然串行。
- token/成本依赖各 Agent 的输出格式，取不到时只能警告，无法精确计费。
- 审批是交互式确认，不是密码学级别的授权。
- Web 面板没有鉴权，只适合本机使用。
- 各 Agent 的输出格式不同；Mesh 用启发式规则提取文本，但始终保留原始 stdout/stderr。
- `dsh` 适配器假设当前环境已经配置并登录了 `dsh headless`。如果使用非默认 profile，在 `mesh.json` 的 `env` 里设置 `DSH_HOME`。

## 开发

```bash
node --test test/*.test.ts
node src/cli.ts doctor
node src/cli.ts run "smoke test" --dry-run --verbose
```

没有运行时 npm 依赖。开发时 Node 24 直接执行 TypeScript；发布前用 `npm run build` 编译到 `dist/`，`prepublishOnly` 会自动构建并跑测试。

测试覆盖：配置校验与 DAG 排序、四种 Agent 事件格式、SQLite 持久化、worktree/diff、取消、恢复、审批、预算、并行合并、能力回退、apply、clean、stats、MCP 工具、Web 启动/取消/SSE。

## 许可

MIT，见 [LICENSE](LICENSE)。
