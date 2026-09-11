# agent-core ports

`@janus-agent/agent-core` imports **zero** Electron/LLM/knowledge/project modules.
Every host capability crosses one of these seams:

| Seam | Core file | Host provides |
|---|---|---|
| Model stream | `loop/vercel-stream-adapter.ts` (`streamTextFn: StreamTextFn`, now **required**) | Shell: `llm/ai-runtime.streamText`. CLI: own transport |
| Workspace identity | `runtime/runtime.ts` (`ResolveWorkspaceRoot`, fail-closed) + `createAgentRuntime()` factory | Shell: office workspace registry. CLI: cwd-based resolver |
| Audit persistence | `runtime/policy-audit-store.ts` (`FilePolicyAuditStore(rootDir)`, `createFilePolicyAuditStore`, `JANUSX_AUDIT_ROOT` override) | Shell: knowledge-root audit dir. CLI: isolated dir or memory |
| Event fan-out | `runtime/runtime.ts` (`onEvent` listener set) | Shell: `webContents.send`. CLI: stdout JSONL |
| Renderer authz | `runtime/renderer-authorization.ts` (`HostIpcEvent`, `createRendererActionAuthorizer(store)`) | Shell: file audit store. Tests/CLI: memory |
| project/command/git tools | **deleted** from core; see `runtime/tools/host-tool-ports.ts` | Shell keeps original impls as plugins via `ToolRegistry`; pure-Node `command.run` + `git.*` + job-backed project subset live in `@janus-agent/node-hosts` |

## Preserved behaviour notes

- `checkpoint-manager` still stores under `<workspace>/.janusX/checkpoints` (product convention, host-independent).
- `WorkspaceAgentRuntime` without a resolver throws on `createSession` (fail-closed, unchanged).
- `FilePolicyAuditStore` default dir replicates the shell layout
  (`<userData>/janusx/knowledge/audit/workspace-policy.jsonl`) so single-host
  behaviour is byte-identical; multi-host setups must pass explicit roots.

## Tool-name contract (do NOT rename without syncing both repos)

`workspace.{read,list,search,edit,create,delete}`, `project.*`, `git.*`, `command.run`.
Blueprint's `BLUEPRINT_READ_ONLY_MODEL_TOOLS` whitelist filters on these names;
renames silently disable blueprint tools. Covered by contract tests (Phase0).
`workspace.delete` is intentionally NOT in the blueprint read-only set: it is a
sequential, preview-gated mutation like `workspace.edit`.

## Non-goals（永久驻壳，明确不迁）

The following stay in the JanusX shell and cross ports only; do NOT
re-implement them in core without a P5-level decision record:

- Knowledge service implementations (`src/main/knowledge/*`) — core only
  carries `shared/knowledge.ts` types plus the `knowledgeSearch` /
  `knowledgeCapture` ports on `ChatTurnPorts`.
- `LlmService` / `ai-runtime` / model catalog / config service.
- Electron IPC + preload + renderer (all UI surfaces).
- Subprocess runner for external CLIs (`src/main/janus-runner/`).
- Roundtable and blueprint maintenance service implementations — core only
  carries `shared/janus/maintenance-types.ts`.
- `project.*` tool implementations — shell plugins via
  `runtime/tools/host-tool-ports.ts`. `command.run` and `git.*` are
  implemented twice under the same tool-name contract: shell plugins for
  JanusX, pure-Node host tools in `@janus-agent/node-hosts` (with a
  JobManager-backed `background:true` channel polled via the
  `project.process-output` / `project.stop-process` / `project.list-processes`
  subset registered from the same package).

## Resolved P5（10 files, all stay in shell — decided 2026-09-08）

The Phase1-extracted files below form the desktop external-agent
(terminal/subagent) contract cluster: preload, renderer stores/components,
`terminal/agent/subagent-run` handlers, five notification modules and
`office-agent-policy` all consume them. Moving any one would drag IPC
channels and renderer contracts into core. None serve the janus-agent loop
or CLI (parsers' only consumer is the shell-side `stream-manager`), so all
stay in JanusX. This section replaces the former `pending P5` list.

- `main/janus-runner/parsers/{claude,codex,opencode,index}.ts` — external-CLI output parsing for the shell stream-manager
- `main/janus-runner/cli-resolver.ts`, `main/janus-runner/stream-manager.ts` — desktop terminal CLI orchestration
- `main/janus-runner/subagent-run-registry.ts`, `main/agent/types.ts` — terminal run tracking + external-agent types
- `shared/ipc/janus-runner.ts`, `shared/subAgentRun.ts` — terminal/subagent IPC + renderer contracts
