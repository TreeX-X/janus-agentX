<p align="center">
  <img src="packages/cli/assets/logo.svg" width="160" alt="Janus-agent CLI logo" />
</p>

# janus-agentX

[English](./README.en.md) · MIT · `janus` CLI v0.1.0

Janus 对话式 Agent 引擎：对话 + 工作区工具调用循环（`runJanusAgentLoop` / `runChatTurn`），
零 `electron` 依赖。宿主能力经由显式端口跨越
（`packages/agent-core/src/main/agent/PORTS.md`）。

开箱即用的独立 `janus` 命令行：在终端里常驻交互（TUI），或以 headless 方式跑单轮 Agent，
读写工作区文件、执行命令、操作 git，全程可审批、可审计。

> 范围说明：**仅 janus-agent**。外部 claude / codex / opencode CLI 的子进程桥接不在此仓库
>（在 JanusX 壳里，位于 `src/main/janus-runner/`）。`project.*` 工具实现同样留在壳里，
>只共享类型与 host 端口；`command.run` 与 `git.*` 在 `@janus-agent/node-hosts` 中有
>规范的纯 Node 实现（同一工具名契约，经共享 runtime 审批），供 janus CLI 直接使用。
>知识服务、roundtable 与 blueprint 维护实现也在壳里，这里只保留共享类型与 host 端口。

## 特性

- **常驻 TUI**：TTY 下默认全屏 Ink 界面（流式输出、工具卡片、diff 预览、待办便签条、命令面板 `Ctrl+P`）；
  非 TTY / `--plain` 自动降级为 readline 纯文本循环
- **Headless 单轮**：`janus chat` 跑一轮就退出，`ChatAgentEvents` 以 JSONL 输出到 stdout，易于脚本编排
- **多 Provider**：`~/.janus/config.json` 维护 OpenAI 兼容 endpoint 目录，`/connect` 向导配 key 并探测连通性
- **Key 安全**：密钥只进 `~/.janus/auth.json`（0600）或环境变量，永不写入 catalog、不回显、不打日志
- **审批 gate**：`auto-run` 直接执行；`per-action` 对写操作逐个 `y/N` 确认；失败默认拒绝（fail-closed）
- **推理力度**：`none|minimal|low|medium|high|xhigh|max|ultra`，与 CodeX 语义对齐
- **多会话**：`/new /switch /rename /delete`（`/switch` 空参即列出），历史落盘 `~/.janus/history/`
- **Agent 工具箱**：工作区读写查改、命令执行（含后台任务）、`git.*`、中途反问（`ask_user`）、todo  tracking

## 环境要求

- **Node.js >= 22**（Ink 7 的硬性要求；推荐 Node 22 LTS 或 Node 24）
- npm（随 Node 自带即可）

## 安装

安装包由 `npm run pack:cli` 构建，产物为自包含 tarball（含全部依赖 bundle，无需再联网装依赖）：

```bash
# 1. 全局安装（把文件名换成实际构建出的版本）
npm install -g ./release/janus-agent-cli-0.1.0.tgz

# 2. 验证
janus version   # -> 0.1.0
janus --help
```

```bash
# 升级：重复上面两步即可（同名覆盖安装）
# 卸载：
npm uninstall -g @janus-agent/cli
```

> 发布到 registry 后同样可用：`npm install -g @janus-agent/cli`。
> 想分发给他人时，把 `release/*.tgz` 传到 GitHub Release 即可（该目录默认不进 git，见 `.gitignore`）。

## 快速开始

```bash
# 常驻交互（无参数 = tui；TTY 下全屏，管道/--plain 下纯文本）
janus
janus tui -C ./my-project --plain

# Headless 单轮：跑一轮就退出，事件以 JSONL 打到 stdout
janus chat -C . -m <model-id> -- "用一句话介绍这个仓库"
```

`chat` 的 stdout 每一行都是 `{"requestId","event"}`，例如：

```jsonc
{"requestId":"...","event":{"type":"text_delta","delta":"这个仓库是 ..."}}
{"requestId":"...","event":{"type":"tool_call_ready","toolName":"workspace.read"}}
{"requestId":"...","event":{"type":"stream_end"}}
```

退出码：`0` 完成 · `1` agent/模型错误 · `2` 用法/配置错误 · `130` 被中断。

注意：`janus [tui]` 中的 `tui` 只有在**零参数**时可省略；带 flag 时必须写明子命令
（`janus tui -C dir`，而不是 `janus -C dir`），`chat` 永远需要显式写出。

## 模型与 Key 配置

三层优先级（前者赢），`chat` 与 `tui` 共用同一套：

| 配置项 | 优先级（高 → 低） |
|---|---|
| model | `--model` > `JANUS_API_KEY` 同级的 `JANUS_MODEL` > 配置文件 `defaultModel` > provider 自身默认 |
| baseURL | `--base-url` > `JANUS_BASE_URL` > provider 条目 `baseURL`（默认 `https://api.openai.com/v1`）|
| key | 会话内存（仅内存，无斜杠命令）> `--api-key` > `auth.json` > `<apiKeyEnv>` > `JANUS_API_KEY` |
| effort | `--effort` > `JANUS_EFFORT` > 配置文件 `defaultEffort` > provider `effort`（默认 `medium`）|

环境变量速查：`JANUS_MODEL` / `JANUS_BASE_URL` / `JANUS_API_KEY` / `JANUS_EFFORT`
（另有 `JANUS_NO_MOUSE=1` 关闭 TUI 鼠标、保留终端原生选中）。

配置文件 `~/.janus/config.json`（**可分享，不含任何密钥**）：

```json
{
  "version": 1,
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    }
  ],
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-chat",
  "defaultEffort": "medium"
}
```

密钥 `~/.janus/auth.json`（0600，仅本机）：`{ "version": 1, "keys": { "deepseek": "sk-..." } }`。
最省事的办法是进 TUI 跑 `/connect` 向导：选 provider → 填 key（只存 auth.json）→
自动探测 `GET /models`（探不通只警告、不回滚）→ 可选模型。

行为补充：

- `chat` 默认**不读任何文件**（flags/env only），除非显式 `--config <path>` 才加载 catalog；
  `tui` 默认读 `~/.janus/config.json`，`--no-config` 可关闭一切文件（纯内存）
- 没有 model 或 key 也能进 TUI（只转圈提醒），但 turn 会失败，直到 `/model` / `/connect` 配好；
  `chat` 则直接拒绝（exit 2），因为 headless 没有补救路径
- provider 声明了非空 `models` 即为“闭世界”：写错的 model id 在本地就被拒绝并给出
  `Did you mean ...?`，不会把 typo 送到计费端

## 命令速查

```bash
janus [tui] [-C <dir>] [-m <id>] [-p <provider>] [--base-url <url>] [--api-key <key>]
            [--config <path> | --no-config]
            [--max-turns <n>] [--timeout-ms <ms>] [--approval-mode auto-run|per-action]
            [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]
            [--conversation <id>] [--fullscreen] [--plain]

janus chat [--workspace <dir>] [--model <id>] [--provider <id>] [--base-url <url>] [--api-key <key>]
           [--config <path>] [--max-turns <n>] [--timeout-ms <ms>] [--approval-mode auto-run]
           [--effort <...>] [--conversation <id>] [--] "prompt"

janus version   # 打印 CLI 版本（单一来源：packages/cli/src/version.ts）
janus help      # 打印帮助（--help / -h 同效）
```

常用 flags：`-C/--workspace` 工作区 · `-m/--model` · `-p/--provider` ·
`--max-turns`（默认 40）· `--timeout-ms` · `--conversation` 恢复指定会话。
`--fullscreen` 需要 TTY，否则会告警并回落到纯文本循环。

TUI 内斜杠命令（`/` 开头 Tab 可补全，未知命令直接报错、绝不送给模型）：

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/status` | 当前 provider / model / baseURL / key 来源 / config 路径 |
| `/connect [id] [key] [base-url]` | provider 配置向导（key 只进 auth.json） |
| `/provider [id]` / `/provider rm <id>` | 列出 / 切换 / 删除 provider |
| `/model [id]` | 列出 / 切换模型 |
| `/effort [level\|序号]` | 推理力度（空参进 picker） |
| `/approval [mode]` | 查看 / 切换 `auto-run\|per-action` |
| `/new [标题]` `/switch [n\|id]` `/rename <标题>` `/delete [n\|id]` | 多会话管理（`/switch` 空参即列出） |
| `/workspace <dir>` | 切换工作区（历史清空） |
| `/compact` | 压缩当前会话上下文为摘要 |
| `/exit` | 退出（`Ctrl+D` 同效） |

按键：`Enter` 发送 · `↑/↓` 输入历史 · `Ctrl+C` 清空输入/取消 turn（1 秒内两次则退出）·
`Esc` 取消 turn · `Ctrl+T` 思考 · `Ctrl+O` 工具输出 · 滚轮/`PgUp`/`PgDn` 滚动 ·
`Ctrl+Home/End` 顶/底 · `Ctrl+↑/↓` 逐行 · `Ctrl+P` 命令面板。
Mid-turn 模型可能反问：TUI 用 `↑↓/Space/c/Enter/Esc` 作答，纯文本模式用数字/标签/`c`/`q`。

## 推理力度（effort）

| 等级 | 含义 |
|---|---|
| `none` | 无推理：最快、最省、直接给答案 |
| `minimal` / `low` | 轻量：草稿、琐碎改动、简单任务 |
| `medium`（默认）| 均衡：日常工作默认档 |
| `high` / `xhigh` | 深度：困难/复杂推理，更慢更贵 |
| `max` | 后端最强档：最慢、最贵 |
| `ultra` | Agent 式拉满：在线上按 `xhigh` 发送 + 客户端任务分解 |

查看用 `/status`，切换用 `/effort <等级或序号>` 或 `--effort` / `JANUS_EFFORT`。

## 审批（approval）

- `auto-run`：工具直接执行（`chat` headless 只支持此模式）
- `per-action`：每次写/创建类操作弹窗 `y/N` 确认（空输入/EOF/中断 = 拒绝）
- `/approval [auto-run|per-action]` 查看或切换；`--approval-mode` 指定启动模式

## 多会话与历史

- 每次启动 TUI 默认开一个全新空会话；传 `--conversation <id>` 可恢复指定会话
- 历史：`~/.janus/history/<id>.jsonl`（messages + tool traces + todos）；文件不可写时退化为纯内存并告警一次
- 文件位置汇总：`~/.janus/config.json`（provider 目录）· `~/.janus/auth.json`（密钥，0600）·
  `~/.janus/history/`（会话）

## Agent 工具箱

模型在 turn 中可调用（全部经 runtime 审批与审计）：

- `workspace.read / list / search / edit / create`：工作区文件读写查改
- `command.run`：命令执行（同步 + `JobManager` 后台任务）
- `git.*`：纯 Node 的 git 操作
- `project.list-processes / process-output / stop-process`：后台任务管理
- `ask_user`：执行中途向人提问确认（阻塞式）
- `todo`：待办写入，TUI 顶部便签条与纯文本模式同步镜像进度

## 故障排查

| 现象 | 处理 |
|---|---|
| `missing model` | `--model <id>` / `JANUS_MODEL` / TUI 内 `/model <id>` |
| `missing API key` | `--api-key` / `JANUS_API_KEY` / `/connect`（`/status` 看来源）|
| `unknown model ... Available: ...` | 照提示改 id；闭世界 provider 会本地拦截 typo |
| `no enabled providers` | `~/.janus/config.json` 为空且没传 `--model`；跑 `/connect` 加一个 |
| `workspace is not a directory` | 检查 `-C/--workspace` 路径 |
| `Unknown command: -C` | 带 flag 必须写 `janus tui ...`（零参数才能省略 `tui`）|
| `--fullscreen needs a TTY` | 管道/CI 里用 `--plain` 或 `janus chat` |
| `connection test failed` | 仅警告（setup 已保存）；检查 baseURL/key，不影响聊天 |
| 历史/config “not writable” | 退化为纯内存运行；检查 `~/.janus` 权限与磁盘 |

## 从源码构建

```bash
npm install
npm run build       # 全 workspace tsc + ESM 后缀修复
npm run typecheck
npm run test        # 全 workspace vitest
npm run pack:cli    # 构建 + esbuild bundle + npm pack，产物在 release/
```

- 安装包链路：`scripts/pack-cli.mjs` 把 `packages/cli`（含其余 4 个 workspace 依赖）
  bundle 成单文件 `release/janus-cli/janus.js`，再配 publishable `package.json` +
  `LICENSE` + 双语 README，`npm pack` 输出 `release/janus-agent-cli-<version>.tgz`
  （`file:` 依赖在 registry 语义下不可安装，所以必须走 bundle，且产物零运行时依赖）
- 版本单一来源：`packages/cli/src/version.ts` 的 `CLI_VERSION` 必须等于
  `packages/cli/package.json` 的 `version`，pack 脚本会断言，不一致直接失败
- 传输出 pin：`ai@3.4.33` + `@ai-sdk/openai@3`（OpenAI 兼容 `baseURL`）；
  `packages/cli/src/model-compat.ts` 的 v3→v1 垫片是从 JanusX llm-core **re-vendor** 的，
  只能重新 vendoring、不要 fork

## 仓库结构

| Package | 内容 |
|---|---|
| `@janus-agent/agent-core` | 对话循环、流、runtime（policy/path/registry/manifest/result/transaction）、checkpoint、environment、`workspace.{read,list,search,edit,create}`、chat-tool 适配、模型工具名称契约 |
| `@janus-agent/node-hosts` | 纯 Node `command.run`（同步 + JobManager 后台）、`git.*`、后台任务 `project.list-processes/process-output/stop-process` |
| `@janus-agent/chat-core` | 会话预算、agent 事件映射、system-prompt 构建、orchestrator 纯函数 |
| `@janus-agent/janus-agent` | Facade：经 `ChatTurnPorts` 的框架无关 `runChatTurn` |
| `@janus-agent/cli` | 独立 `janus` CLI：`janus chat` headless 单轮，`janus[tui]` 常驻交互 |

布局约束：`packages/agent-core/src` 镜像 JanusX `src/main/janus-agent/**`、
`shared/**`、`main/lib/atomic-file.ts`，相对 import 保持字节一致。

品牌：logo 矢量稿 `packages/cli/assets/logo.svg`（透明底、仅图形；白色 `>` 笔画假设深色宿主）。
终端 TUI/REPL 启动横幅仍用 `packages/cli/src/logo.ts` 的 ASCII `JANUSX` 字样
（块字符承载不了矢量 mark，故意保留）。

## 开源协议

MIT © 2026 TreeX-X，见 [LICENSE](./LICENSE)。
