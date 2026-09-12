<p align="center">
  <img src="packages/cli/assets/logo.svg" width="160" alt="Janus-agent CLI logo" />
</p>

# janus-agentX

[中文](./README.md) · MIT · `janus` CLI v0.1.0

The Janus conversational agent engine: a dialogue + workspace tool-call loop
(`runJanusAgentLoop` / `runChatTurn`) with zero `electron` imports.
Host capabilities cross explicit ports
(`packages/agent-core/src/main/agent/PORTS.md`).

A standalone `janus` CLI ships with it: stay resident in the terminal (TUI),
or run headless single turns that read/write workspace files, run commands and
operate git — all approval-gated and auditable.

> Scope: **janus-agent only**. The subprocess bridge for external
> claude / codex / opencode CLIs is NOT in this repo (in the JanusX shell it lives
> under `src/main/janus-runner/`). `project.*` tool implementations stay in the shell
> too — only shared types and host ports live here. `command.run` and `git.*` have
> canonical pure-Node implementations in `@janus-agent/node-hosts` (same tool-name
> contract, approved through the shared runtime), consumed directly by the janus CLI.
> Knowledge services, roundtable and blueprint maintenance implementations likewise
> stay in the shell — only their shared types and host ports live here.

## Features

- **Resident TUI**: fullscreen Ink UI on a TTY (streaming output, tool cards, diff
  previews, todo sticky bar, `Ctrl+P` command palette); auto-degrades to a readline
  plain-text loop on pipes / `--plain`
- **Headless single turns**: `janus chat` runs one turn and exits; `ChatAgentEvents`
  stream as JSONL on stdout for easy scripting
- **Multi-provider**: `~/.janus/config.json` holds an OpenAI-compatible endpoint catalog;
  the `/connect` wizard stores keys and probes reachability
- **Key safety**: secrets only ever live in `~/.janus/auth.json` (0600) or env vars —
  never in the catalog, never echoed, never logged
- **Approval gates**: `auto-run` executes immediately; `per-action` confirms each write
  with `y/N`; fail-closed on empty input / EOF / abort
- **Reasoning effort**: `none|minimal|low|medium|high|xhigh|max|ultra`, CodeX-aligned semantics
- **Multi-session**: `/new /switch /rename /delete` (bare `/switch` lists), history persisted to `~/.janus/history/`
- **Agent toolbox**: workspace file ops, command execution (incl. background jobs),
  `git.*`, mid-turn user questions (`ask_user`), todo tracking

## Requirements

- **Node.js >= 22** (hard requirement from Ink 7; Node 22 LTS or Node 24 recommended)
- npm (bundled with Node is fine)

## Install

The installable artifact is built with `npm run pack:cli` — a self-contained tarball
(everything bundled, no post-install network needed):

```bash
# 1. Install globally (swap in the version you actually built)
npm install -g ./release/janus-agent-cli-0.1.0.tgz

# 2. Verify
janus version   # -> 0.1.0
janus --help
```

```bash
# Upgrade: repeat the steps above (same name overwrites)
# Uninstall:
npm uninstall -g @janus-agent/cli
```

> Once published to a registry: `npm install -g @janus-agent/cli`.
> To share with others, upload `release/*.tgz` to a GitHub Release
> (that directory is git-ignored by default, see `.gitignore`).

## Quick start

```bash
# Resident interactive loop (no argv = tui; fullscreen on TTY, plain text on pipes/--plain)
janus
janus tui -C ./my-project --plain

# Headless single turn: run one turn and exit, events as JSONL on stdout
janus chat -C . -m <model-id> -- "Describe this repo in one sentence"
```

Each stdout line of `chat` is one `{"requestId","event"}` object, e.g.:

```jsonc
{"requestId":"...","event":{"type":"text_delta","delta":"This repo is ..."}}
{"requestId":"...","event":{"type":"tool_call_ready","toolName":"workspace.read"}}
{"requestId":"...","event":{"type":"stream_end"}}
```

Exit codes: `0` done · `1` agent/model error · `2` usage/config error · `130` interrupted.

Note: the `tui` word in `janus [tui]` may only be omitted with **zero argv**; with flags
you must spell out the subcommand (`janus tui -C dir`, not `janus -C dir`), and `chat`
always needs its explicit subcommand.

## Model & key configuration

One precedence chain shared by `chat` and `tui` (earlier wins):

| Item | Precedence (high → low) |
|---|---|
| model | `--model` > `JANUS_MODEL` > file `defaultModel` > provider default |
| baseURL | `--base-url` > `JANUS_BASE_URL` > entry `baseURL` (default `https://api.openai.com/v1`) |
| key | session memory (memory only, no slash command) > `--api-key` > `auth.json` > `<apiKeyEnv>` > `JANUS_API_KEY` |
| effort | `--effort` > `JANUS_EFFORT` > file `defaultEffort` > provider `effort` (default `medium`) |

Env cheat-sheet: `JANUS_MODEL` / `JANUS_BASE_URL` / `JANUS_API_KEY` / `JANUS_EFFORT`
(plus `JANUS_NO_MOUSE=1` to disable TUI mouse and keep native terminal selection).

`~/.janus/config.json` (**shareable, never holds secrets**):

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

Keys live in `~/.janus/auth.json` (0600, local only):
`{ "version": 1, "keys": { "deepseek": "sk-..." } }`.
Easiest path: open the TUI and run the `/connect` wizard — pick a provider, enter the key
(stored to auth.json only), automatic `GET /models` probe (a failed probe only warns,
never rolls back), optional model pick.

More behavior notes:

- `chat` reads **no files** by default (flags/env only); pass `--config <path>` explicitly
  to load a catalog. `tui` reads `~/.janus/config.json` by default; `--no-config` disables
  every file (pure memory)
- The TUI starts fine without a model or key (it just reminds you); turns fail until
  `/model` / `/connect` is set. `chat` refuses immediately (exit 2) since
  headless has no recovery path
- A provider declaring a non-empty `models` list is "closed-world": a mistyped model id is
  rejected locally with `Did you mean ...?` and never reaches billing

## Command reference

```bash
janus [tui] [-C <dir>] [-m <id>] [-p <provider>] [--base-url <url>] [--api-key <key>]
            [--config <path> | --no-config]
            [--max-turns <n>] [--timeout-ms <ms>] [--approval-mode auto-run|per-action]
            [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]
            [--conversation <id>] [--fullscreen] [--plain]

janus chat [--workspace <dir>] [--model <id>] [--provider <id>] [--base-url <url>] [--api-key <key>]
           [--config <path>] [--max-turns <n>] [--timeout-ms <ms>] [--approval-mode auto-run]
           [--effort <...>] [--conversation <id>] [--] "prompt"

janus version   # print the CLI version (single source: packages/cli/src/version.ts)
janus help      # print help (--help / -h work too)
```

Handy flags: `-C/--workspace` workspace dir · `-m/--model` · `-p/--provider` ·
`--max-turns` (default 40) · `--timeout-ms` · `--conversation` resume a session.
`--fullscreen` needs a TTY, otherwise it warns and falls back to the plain loop.

Slash commands inside the TUI (leading `/`, Tab-completable; unknown commands error out
and never reach the model):

| Command | Effect |
|---|---|
| `/help` | show help |
| `/status` | effective provider / model / baseURL / key source / config path |
| `/connect [id] [key] [base-url]` | provider setup wizard (keys go to auth.json only) |
| `/provider [id]` / `/provider rm <id>` | list / switch / remove providers |
| `/model [id]` | list / switch models |
| `/effort [level\|number]` | reasoning effort (bare opens the picker) |
| `/approval [mode]` | show / switch `auto-run\|per-action` |
| `/new [title]` `/switch [n\|id]` `/rename <title>` `/delete [n\|id]` | multi-session management (bare `/switch` lists) |
| `/workspace <dir>` | switch workspace (history is cleared) |
| `/compact` | compact conversation context into a summary |
| `/exit` | leave (`Ctrl+D` works too) |

Keys: `Enter` send · `↑/↓` input history · `Ctrl+C` clear input / cancel turn (twice within
1s exits) · `Esc` cancel turn · `Ctrl+T` thinking · `Ctrl+O` tool output ·
wheel / `PgUp` / `PgDn` scroll · `Ctrl+Home/End` top/bottom · `Ctrl+↑/↓` step lines ·
`Ctrl+P` command palette.
Mid-turn the agent may ask option questions: TUI answers with `↑↓/Space/c/Enter/Esc`,
the plain loop with numbers/labels/`c`/`q`.

## Reasoning effort

| Level | Meaning |
|---|---|
| `none` | no reasoning: fastest, cheapest, direct answers |
| `minimal` / `low` | light: drafts, trivial edits, simple tasks |
| `medium` (default) | balanced: the everyday default |
| `high` / `xhigh` | deep: hard/complex reasoning, slower and costlier |
| `max` | backend max: slowest, most expensive |
| `ultra` | agentic max: sent on the wire as `xhigh` + client-side task decomposition |

Inspect with `/status`, switch with `/effort <level|number>` or `--effort` / `JANUS_EFFORT`.

## Approval

- `auto-run`: tools run immediately (the only mode `chat` headless supports)
- `per-action`: every write/create asks `y/N` (empty input / EOF / abort = deny)
- `/approval [auto-run|per-action]` shows or switches; `--approval-mode` sets it at startup

## Sessions & history

- Every TUI restart begins with a fresh empty conversation; pass `--conversation <id>`
  to resume a specific one
- History: `~/.janus/history/<id>.jsonl` (messages + tool traces + todos); degrades to
  memory-only with a one-time warning when the file is unavailable
- File map: `~/.janus/config.json` (provider catalog) · `~/.janus/auth.json` (keys, 0600) ·
  `~/.janus/history/` (conversations)

## Agent toolbox

What the model may call during a turn (all approved and audited through the runtime):

- `workspace.read / list / search / edit / create`: workspace file operations
- `command.run`: command execution (sync + `JobManager`-backed background jobs)
- `git.*`: pure-Node git operations
- `project.list-processes / process-output / stop-process`: background job management
- `ask_user`: blocking mid-turn questions to the human
- `todo`: todo writes, mirrored in the TUI sticky bar and the plain loop

## Troubleshooting

| Symptom | Fix |
|---|---|
| `missing model` | `--model <id>` / `JANUS_MODEL` / `/model <id>` in the TUI |
| `missing API key` | `--api-key` / `JANUS_API_KEY` / `/connect` (check `/status` for the source) |
| `unknown model ... Available: ...` | fix the id from the hint; closed-world providers catch typos locally |
| `no enabled providers` | empty `~/.janus/config.json` and no `--model`; add one via `/connect` |
| `workspace is not a directory` | check the `-C/--workspace` path |
| `Unknown command: -C` | with flags you must write `janus tui ...` (only zero argv may omit `tui`) |
| `--fullscreen needs a TTY` | use `--plain` or `janus chat` on pipes/CI |
| `connection test failed` | warning only (setup is saved); check baseURL/key, chatting still works |
| history/config "not writable" | degrades to memory-only; check `~/.janus` permissions and disk space |

## Build from source

```bash
npm install
npm run build       # tsc across workspaces + ESM specifier fix-up
npm run typecheck
npm run test        # vitest across workspaces
npm run pack:cli    # build + esbuild bundle + npm pack, output under release/
```

- Packaging: `scripts/pack-cli.mjs` bundles `packages/cli` (plus the other 4 workspace
  deps) into one file `release/janus-cli/janus.js`, pairs it with publishable
  `package.json` + `LICENSE` + both READMEs, and `npm pack`s
  `release/janus-agent-cli-<version>.tgz`
  (bundling is required because `file:` deps are not installable from a registry;
  the result has zero runtime dependencies)
- Version single source: `CLI_VERSION` in `packages/cli/src/version.ts` must equal
  `packages/cli/package.json` `version`; the pack script asserts this and fails otherwise
- Transport pin: `ai@3.4.33` + `@ai-sdk/openai@3` over an OpenAI-compatible `baseURL`;
  the v3→v1 shim in `packages/cli/src/model-compat.ts` is **re-vendored** from the JanusX
  llm-core — re-vendor it, never fork it

## Repo layout

| Package | Contents |
|---|---|
| `@janus-agent/agent-core` | Dialogue loop, stream, runtime (policy/path/registry/manifest/result/transaction), checkpoint, environment, `workspace.{read,list,search,edit,create}`, chat-tool adapters, model tool-name contract |
| `@janus-agent/node-hosts` | Pure-Node `command.run` (sync + JobManager-backed background), `git.*`, background-job `project.list-processes/process-output/stop-process` |
| `@janus-agent/chat-core` | Chat session budget, agent-event mapping, system-prompt builder, orchestrator pure helpers |
| `@janus-agent/janus-agent` | Facade: framework-agnostic `runChatTurn` over agent-core + chat-core via `ChatTurnPorts` |
| `@janus-agent/cli` | Standalone `janus` CLI: `janus chat` runs one agent turn headless |

Layout rule: `packages/agent-core/src` mirrors JanusX `src/main/janus-agent/**`,
`shared/**`, `main/lib/atomic-file.ts` so relative imports keep working byte-identical.

Brand: vector logo at `packages/cli/assets/logo.svg` (transparent background, mark only;
the white `>` stroke assumes a dark host surface). Terminal TUI/REPL startup banners
still use the ASCII `JANUSX` wordmark in `packages/cli/src/logo.ts`
(block characters can't carry the vector mark, so the ASCII banner is intentionally left as-is).

## License

MIT © 2026 TreeX-X, see [LICENSE](./LICENSE).
