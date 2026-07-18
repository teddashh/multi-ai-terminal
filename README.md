# Multi-AI Terminal

**English** | [繁體中文](./README.zh-TW.md)

A local web workbench for composing and running **multi-agent workflows across headless CLI coding agents** — Claude Code, Codex CLI, Grok CLI, and Antigravity (Gemini). Drag agents onto workflow stages, let a real LLM orchestrator gate each stage, and watch every agent's output stream into one categorized, replayable feed.

Successor to [multi-ai-chat-desktop](https://github.com/teddashh/multi-ai-chat-desktop): instead of scraping web chats, every agent is a real headless CLI process whose JSONL stream is normalized into a single event schema.

## How it works

- **Workspaces** — each points at a directory (git-aware). The rail shows every workspace's last workflow and live state.
- **Workflows** — ordered stages; each stage holds agent slots (drag from the palette; multiple same-provider instances allowed, Σ ≤ 12 per stage). Per-slot: model, reasoning effort, permission tier, prompt template, count.
- **Orchestrator** — a real CLI agent (any provider) that receives a digest of each gated stage's candidates and answers with a strict-JSON gate decision: advance / retry (with per-node targeting + prompt addendum) / abort. Deterministic budget caps; parse failures degrade to safe advance.
- **Stage isolation** — optional git-worktree isolation per node; each attempt's work is captured as a binary patch you can inspect and apply from the UI.
- **Stream panel** — every event from every agent, categorized **your messages / agent replies / tooling / thinking**, virtualized, filterable per node/role/search, with full replay of past runs from the durable event log.

## Quickstart

Requirements: Node.js ≥ 20, Git ≥ 2.32 recommended (older Git falls back to plain `git apply --check`), plus whichever agent CLIs you want: `claude`, `codex`, `grok`, `agy`.

```sh
npm install
npm run build
npm start                      # serves web UI + API on http://127.0.0.1:7788
# options: --port N --host H --data-dir DIR --token SECRET
```

Open the UI, add a workspace (absolute path), pick a builtin workflow (Planning / Build / Review), drop agents onto stages, write the task, Start.

Dev mode: `npm run dev` (vite + API with hot reload). Tests: `npm test` (145 tests). Typecheck: `npm run typecheck`.

## Desktop app

Install desktop builds from the repository's GitHub Releases page. The desktop app requires Node.js ≥ 20 on `PATH`; set `MAT_NODE` to the path of a specific compatible Node.js binary if needed.

- Windows: download the `-setup.exe` (NSIS) or `.msi` and run it. The WebView2 runtime is preinstalled on Windows 10/11, and the installer bootstraps it if missing. Install Node.js ≥ 20 with `winget install OpenJS.NodeJS.LTS`; Git for Windows is also required for worktree isolation features. Set `MAT_NODE` to the path of a specific `node.exe` if needed.
- Debian/Ubuntu: download the `.deb`, then run `sudo apt install ./file.deb`.
- Other Linux distributions: download the `.AppImage`, run `chmod +x ./Multi-AI-Terminal*.AppImage`, then launch it. RPM packages are also provided.
- macOS: open the downloaded `.dmg` and copy the app to Applications. Version 1 builds are unsigned and not notarized, so on first launch right-click Multi-AI Terminal and choose **Open** to pass Gatekeeper.

The desktop shell runs the exact same bundled server on an ephemeral `127.0.0.1` port and keeps data in `~/.multi-ai-terminal/`, just like the web-served build. To build the desktop resources locally, run `npm run build` followed by `npm run desktop:bundle`; `npm run desktop:build` additionally requires the Rust and native Tauri build prerequisites.

## Providers (verified invocations)

| Provider | CLI | Stream | Notes |
|---|---|---|---|
| claude | `claude -p --output-format stream-json --verbose` | full (text/thinking/tools/cost) | resume via `--resume` |
| codex | `codex exec --json -m gpt-5.6-sol` | full (incl. command exec events) | effort via `-c model_reasoning_effort` |
| grok | `grok --prompt-file F --output-format streaming-json` | thought/text only (tools run silently) | grok ≥ 0.2.93: don't pass `-p` with `--prompt-file` |
| agy | `agy -p "PROMPT" --model "Gemini 3.1 Pro (High)"` | plain text | model = display name; no JSON mode |
| mock | in-process | scripted | deterministic; `MOCK_REPLY:` echo mode for tests |

Permission tiers per slot: `safe` (read-only), `auto` (accept edits), `full` (bypass sandbox) — mapped to each CLI's native flags (SPEC §4.5).

## Trust model

Binds `127.0.0.1` by default. `--host 0.0.0.0` exposes the API/UI to your network — set `--token` (REST bearer + WS query token). Anyone with access can run arbitrary CLI agents in your workspaces; treat the port accordingly (Tailscale-only exposure recommended).

## Data

`~/.multi-ai-terminal/` (override with `--data-dir` / `MAT_DATA_DIR`): `workspaces.json`, `workflows/*.json`, `runs/<runId>/run.json` + `events.jsonl` + `raw/*.jsonl` (untouched CLI output per attempt) + `artifacts/*.patch`. Retention: last 100 runs per workspace, worktrees/branches pruned on delete.

## Docs

- [SPEC.md](./SPEC.md) — the engineering contract (v1.1)
- [docs/spec-review-panel.md](./docs/spec-review-panel.md) — 4-model spec review record
- [docs/code-review-panel.md](./docs/code-review-panel.md) — 4-model code review record (25 findings fixed, 3 refuted)

Built by a 4-model panel process: spec + code review by Claude Fable 5, Codex GPT-5.6-sol, Gemini 3.1 Pro, and Grok 4.5; implementation by parallel Codex workers in isolated git worktrees.

## Known limitations (v1)

- Grok's streaming JSON emits no tool events — grok nodes show thinking/text only; digests report tool-count "n/a".
- Antigravity (`agy`) has no headless JSON mode — plain-text stream, no session resume (orchestrator re-briefs each gate).
- After a machine reboot, crash recovery kills stale process groups by persisted PID; PID-recycling risk is accepted.
- Event ring keeps 20k events in browser memory; older history pages in from the server with an explicit trim notice.
- On Windows, process termination uses `taskkill /T /F` (forced tree kill); if node exits on its own first, detached grandchildren are reaped by the stale-PID sweep on next server start.
