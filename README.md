<p align="center">
  <img src="packages/cli/assets/logo.svg" width="160" alt="Janus-agent CLI logo" />
</p>

# janus-agentX

Janus agent engine extracted from JanusX: dialogue + workspace tool-call
loop (`runJanusAgentLoop` / `runChatTurn`) with zero `electron` imports.
Host capabilities cross explicit ports
(`packages/agent-core/src/main/agent/PORTS.md`).

Scope: **janus-agent only**. The subprocess runner for external
claude/codex/opencode CLIs is NOT here on purpose — in JanusX it lives
under `src/main/janus-runner/`; `janus-chat` there now means the chat UI.
`project.*` tool implementations stay in the JanusX
shell and cross `host-tool-ports`; `command.run` and `git.*` have canonical
pure-Node implementations in `@janus-agent/node-hosts` (same tool-name
contract, approval through the shared runtime), consumed by the janus CLI.
Knowledge services, roundtable and blueprint maintenance
implementations likewise stay in the shell — only their shared types and
host ports live here.

## Packages

| Package | Contents |
|---|---|
| `@janus-agent/agent-core` | Dialogue loop, stream, runtime (policy/path/registry/manifest/result/transaction), checkpoint, environment, workspace.{read,list,search,edit,create}, chat-tool adapters, model tool-name contract |
| `@janus-agent/node-hosts` | Pure-Node `command.run` (sync + JobManager-backed background), `git.*`, background-job `project.list-processes/process-output/stop-process` |
| `@janus-agent/chat-core` | Chat session budget, agent-event mapping, system-prompt builder, orchestrator pure helpers |
| `@janus-agent/janus-agent` | Facade: framework-agnostic `runChatTurn` over agent-core + chat-core via `ChatTurnPorts` |
| `@janus-agent/cli` | Standalone `janus` CLI: `janus chat` runs one agent turn headless |

## CLI

```bash
node packages/cli/dist/cli.js chat --workspace . --model <id> -- "prompt"
# Model config via flags or env: JANUS_MODEL / JANUS_BASE_URL / JANUS_API_KEY
# ChatAgentEvents stream as JSONL on stdout.
```

Transport pins the shell-proven combo (`ai@3.4.33` +
`@ai-sdk/openai@3`, OpenAI-compatible `baseURL`); the v3→v1 shim in
`packages/cli/src/model-compat.ts` is vendored from JanusX llm-core and
must be re-vendored, not forked.

## Brand

Logo asset: `packages/cli/assets/logo.svg` (transparent background, mark
only). The `AI` mark: titanium-gray `A` (`#8b92a0`) whose upper-right stroke
doubles as a white terminal `>` prompt, plus a terminal-orange `I`
(`#ff6b00`). The white stroke assumes a dark host surface.

> Terminal hosts (TUI/REPL startup banner) still use the ASCII `JANUSX`
> wordmark in `packages/cli/src/logo.ts` — block characters can't carry the
> vector mark, so the ASCII banner is intentionally left as-is.

## Layout rule

`packages/agent-core/src` mirrors JanusX `src/main/janus-agent/**`,
`shared/**`, `main/lib/atomic-file.ts` so relative imports keep working
byte-identical.
