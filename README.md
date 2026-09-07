# janus-agentX

Janus agent engine extracted from JanusX. JanusX keeps the Electron shell;
all intelligence lives here and is consumed in-process by the shell and
headless by the standalone `janus` CLI.

## Packages

| Package | Contents |
|---|---|
| `@janus-agent/contracts` | Shared IPC/type contracts copied from JanusX `src/shared` (no runtime deps) |
| `@janus-agent/agent-core` | Agent loop, stream, parsers, runtime (policy/path/registry/manifest/result/transaction), checkpoint, environment, cli-resolver, stream-manager. Zero `electron` imports; host capabilities via `ports` |
| `@janus-agent/chat-core` | Chat session budget, agent-event mapping, system-prompt builder, orchestrator pure helpers |
| `@janus-agent/janus-agent` | Facade (planned Phase3): LLM service, knowledge engine, roundtable, blueprint maintenance |
| `@janus-agent/cli` | Standalone `janus` CLI (planned Phase4) |

## Migration spec

See JanusX `docs/08-JanusX壳体化与Agent外迁实施方案.md` (Phase0-Phase5).

## Layout rule

`packages/agent-core/src` mirrors JanusX `src` (`main/agent/**`, `shared/**`,
`main/lib/atomic-file.ts`) so relative imports keep working byte-identical.
Host-coupled files are replaced by port-based versions documented in
`packages/agent-core/src/main/agent/PORTS.md`.
