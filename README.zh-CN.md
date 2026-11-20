# Mesh

[English](README.md) | **简体中文**

Mesh 是一个本地编排器，用来调度你机器上已经装好的编码 Agent。它把一个目标拆成一个小型工作流，为每个 Agent 准备干净的工作区，并在步骤之间传递结构化产物。

它**不是**任务市场、聊天室，也不是新的 Agent 运行时。执行任务的仍然是 Claude Code、Codex、Antigravity CLI 和 DSH；Mesh 只决定谁来做哪一步，并让交接过程可检查。

```
目标 ──► 实现（Claude Code） ──► 审查（Codex） ──► 验证（DSH，可选）
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
- Git（可选，但推荐；有 Git 才能使用隔离 worktree 和更干净的 diff）

本机验证过的版本：`claude 2.1.325`、`codex 0.164.0`、`agy 1.5.5`、`dsh 0.2.2-rc.1`。

## 快速开始

```bash
cd /path/to/your/project
node /path/to/mesh/src/cli.ts init      # 创建 mesh.json 和 prompts/
node /path/to/mesh/src/cli.ts doctor
node /path/to/mesh/src/cli.ts run "给 /api/items 加上游标分页"
```

想少打点字，可以全局链接一次：

```bash
cd /path/to/mesh
npm link
mesh doctor
```

`mesh run` 是同步执行的，会打印每一步的进度。加 `--verbose` 可以实时看到 Agent 的输出。

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
mesh status [run_id]               查看某次运行或最近几次运行
mesh logs <run_id> [--step id]     打印事件日志
mesh mcp                           在 stdio 上启动 MCP server
mesh init                          在缺失时创建 mesh.json 和 prompts/
```

`run` 的选项：

```text
--workflow <name>    工作流名称（默认：implement-review）
--workspace <path>   要操作的工作区（默认：当前目录）
--run-id <id>        复用已有 run id
--dry-run            用本地 mock 替代 Agent
--verbose            实时输出 Agent 文本
--quiet              只输出错误和最终摘要
--json               输出机器可读的结果
```

## 工作流

默认的 `implement-review`：

1. **implement** — Claude Code 修改工作区。
2. **review** — Codex 检查工作区和 diff，按严重级别报告问题。

`implement-review-verify` 会在后面再加一个 DSH 验证步骤，运行测试/构建命令并报告失败。

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

步骤通过 `needs` 组成 DAG。P0 会按依赖顺序串行执行；数据模型已经为并行分支留好了位置。

## 提示词变量

提示词文件支持：

| 变量 | 含义 |
|---|---|
| `{{goal}}` | 用户给出的目标 |
| `{{workspace}}` | 本次运行的隔离工作区 |
| `{{run_id}}` | 运行 id |
| `{{step_id}}` | 步骤 id |
| `{{diff}}` | 当前 diff（在步骤修改文件之前为空） |
| `{{source_root}}` | 原始项目目录 |

## 一次运行发生了什么

1. Mesh 读取 `mesh.json`，校验工作流，并创建 `.mesh/runs/<run_id>/`。
2. 准备隔离工作区：
   - 如果项目是 Git 仓库，**并且** `mesh.json` 已经提交，就从 `HEAD` 创建一个 detached worktree；
   - 否则复制一份项目，排除 `.mesh/`、`.git/` 和 `node_modules/`。
3. 每一步的提示词渲染后写到 `.mesh/runs/<run_id>/prompts/<step>.md`。
4. Agent 的 stdout 会尽量按 NDJSON 解析，并写入 `.mesh/mesh.db` 和 `events.ndjson`。
5. 最终文本、原始事件、stderr 和 diff 都保存在 `.mesh/runs/<run_id>/` 下。
6. Mesh 不会 commit、push、deploy，也不会删除原始工作区。

产物结构：

```
.mesh/runs/<run_id>/
  brief.md
  prompts/<step>.md
  steps/<step>.md
  artifacts/diff-<step>.patch
  events.ndjson
  workspace/
```

控制面数据在 `.mesh/mesh.db`（SQLite，WAL 模式）。记得把 `.mesh/` 加进 `.gitignore`。如果删除 `.mesh/` 时还有 worktree 运行记录，之后执行一次 `git worktree prune`。

## MCP

`mesh mcp` 通过 stdio 提供 JSON-RPC 接口，暴露四个工具：

| 工具 | 用途 |
|---|---|
| `mesh_run` | 在后台启动一个工作流，返回 run id |
| `mesh_status` | 查看某次运行的步骤和产物 |
| `mesh_agents` | 列出已配置的 Agent |
| `mesh_artifacts` | 列出某次运行的产物 |

在 Claude Code 中注册：

```bash
claude mcp add mesh -- node /path/to/mesh/src/cli.ts mcp
```

Codex 添加一个指向同一命令的 stdio MCP server 即可。Antigravity 可以用 `agy mcp add` 添加同一个 `node .../src/cli.ts mcp` 命令。

这样 Agent 不用离开自己的会话，就能把一段有边界的工作委派出去：

```
用 mesh_run 启动目标“修复分页测试失败”，然后轮询 mesh_status。
```

## 配置

`mesh.json` 顶层只有两个对象：`agents` 和 `workflows`。

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
  "promptFile": "prompts/review.md"
}
```

小工作流可以直接用 `prompt` 代替 `promptFile`。

## 安全默认值

- 纯本地；Mesh 本身没有服务器、没有遥测、不主动上云。
- Agent 在复制的工作区或 detached worktree 里运行，永远不直接动原始目录。
- 默认配置里没有 `--dangerously-skip-permissions` 之类的绕过参数。
- 提示词会要求 Agent 不 commit、不 push、不 deploy、不打印密钥。
- CLI 没有破坏性命令；删除 `.mesh/` 由用户自己决定。
- Agent CLI 仍可能要求审批或登录；Mesh 不会绕过它们自己的权限系统。

如果某个 CLI 卡在交互式提示上，先单独跑一次它的登录/信任流程，再用 `--verbose` 重跑 Mesh，看它停在哪一步。

Codex 需要可写的 `CODEX_HOME`（通常是 `~/.codex`）。在限制很严的沙箱里，它可能报 `failed to initialize in-process app-server client: Operation not permitted`；换到普通终端运行 Mesh，或把 `CODEX_HOME` 指向一个可写的 profile。

## 当前限制

- P0 串行执行步骤，还没有并行分支调度。
- 没有 token/成本统计。
- 审批是提示词级别的，不是密码学级别的。
- MCP 的 `mesh_run` 是 fire-and-forget；需要自己轮询 `mesh_status`。
- 各 Agent 的输出格式不同；Mesh 用启发式规则提取文本，但始终保留原始 stdout/stderr。
- `dsh` 适配器假设当前环境已经配置并登录了 `dsh headless`。如果使用非默认 profile，在 `mesh.json` 的 `env` 里设置 `DSH_HOME`。

## 开发

```bash
node --test test/*.test.ts
node src/cli.ts doctor
node src/cli.ts run "smoke test" --dry-run --verbose
```

没有构建步骤，也没有运行时 npm 依赖。TypeScript 由 Node 24 直接执行；`tsconfig.json` 只用于编辑器和类型检查。

## 路线图

- 并行 DAG 执行和每步独立 worktree
- 基于能力的路由和回退（`coding` → Claude，`review` → Codex）
- token/成本预算和单次运行限额
- 破坏性步骤的交互式审批门
- 更多工作流：`research-implement-review`、`debug-fix-verify`
- 基于 `.mesh/mesh.db` 的 Web 面板
