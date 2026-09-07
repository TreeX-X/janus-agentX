# janus-agentX

Janus agent engine extracted from JanusX: dialogue + workspace tool-call
loop (`runJanusAgentLoop` / `runChatTurn`) with zero `electron` imports.
Host capabilities cross explicit ports
(`packages/agent-core/src/main/agent/PORTS.md`).

Scope: **janus-agent only**. The subprocess runner for external
claude/codex/opencode CLIs is NOT here on purpose — in JanusX it lives
under `src/main/janus-runner/`; `janus-chat` there now means the chat UI.

## Packages

| Package | Contents |
|---|---|
| `@janus-agent/agent-core` | Dialogue loop, stream, runtime (policy/path/registry/manifest/result/transaction), checkpoint, environment, workspace tools, chat-tool adapters |
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

## Layout rule

`packages/agent-core/src` mirrors JanusX `src/main/janus-agent/**`,
`shared/**`, `main/lib/atomic-file.ts` so relative imports keep working
byte-identical.
