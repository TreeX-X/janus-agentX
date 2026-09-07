# agent-core ports

`@janus-agent/agent-core` imports **zero** Electron/LLM/knowledge/project modules.
Every host capability crosses one of these seams:

| Seam | Core file | Host provides |
|---|---|---|
| Model stream | `loop/vercel-stream-adapter.ts` (`streamTextFn: StreamTextFn`, now **required**) | Shell: `llm/ai-runtime.streamText`. CLI: own transport |
| Workspace identity | `runtime/runtime.ts` (`ResolveWorkspaceRoot`, fail-closed) + `createAgentRuntime()` factory | Shell: office workspace registry. CLI: cwd-based resolver |
| Audit persistence | `runtime/policy-audit-store.ts` (`FilePolicyAuditStore(rootDir)`, `createFilePolicyAuditStore`, `JANUSX_AUDIT_ROOT` override) | Shell: knowledge-root audit dir. CLI: isolated dir or memory |
| Event fan-out | `subagent-run-registry.ts` (`setEventSink`, was `setMainWindow`) | Shell: `webContents.send`. CLI: stdout JSONL |
| Renderer authz | `runtime/renderer-authorization.ts` (`HostIpcEvent`, `createRendererActionAuthorizer(store)`) | Shell: file audit store. Tests/CLI: memory |
| project/command/git tools | **deleted** from core; see `runtime/tools/host-tool-ports.ts` | Shell keeps original impls as plugins via `ToolRegistry` |

## Preserved behaviour notes

- `checkpoint-manager` still stores under `<workspace>/.janusX/checkpoints` (product convention, host-independent).
- `WorkspaceAgentRuntime` without a resolver throws on `createSession` (fail-closed, unchanged).
- `FilePolicyAuditStore` default dir replicates the shell layout
  (`<userData>/janusx/knowledge/audit/workspace-policy.jsonl`) so single-host
  behaviour is byte-identical; multi-host setups must pass explicit roots.

## Tool-name contract (do NOT rename without syncing both repos)

`workspace.{read,list,search,edit,create}`, `project.*`, `git.*`, `command.run`.
Blueprint's `BLUEPRINT_READ_ONLY_MODEL_TOOLS` whitelist filters on these names;
renames silently disable blueprint tools. Covered by contract tests (Phase0).
