# Multi-AI Terminal

**English** | [繁體中文](./README.zh-TW.md)

A local web workbench for composing and running **multi-agent workflows across headless CLI coding agents** — Claude Code, Codex CLI, Grok CLI, and Antigravity (Gemini). Drag agents onto workflow stages, let a real LLM orchestrator gate each stage, and watch every agent's output stream into one categorized, replayable feed.

Successor to [multi-ai-chat-desktop](https://github.com/teddashh/multi-ai-chat-desktop): instead of scraping web chats, every agent is a real headless CLI process whose JSONL stream is normalized into a single event schema.

## How it works

- **Projects + Launchpad** — each workspace points at a directory (git-aware). The rail switches between project selection and a launch composer without losing drafts; common mode/readiness/task settings stay visible while advanced stage editing lives under **Customize**.
- **Workflows** — ordered stages; each stage holds agent slots (drag from the advanced palette; multiple same-provider instances allowed, Σ ≤ 12 per stage). Per-slot: model, reasoning effort, permission tier, prompt template, count.
- **Orchestrator** — a real CLI agent (any provider) that receives a digest of each gated stage's candidates and answers with a strict-JSON gate decision: advance / retry (with per-node targeting + prompt addendum) / abort. Deterministic budget caps; parse failures degrade to safe advance.
- **Stage isolation** — optional git-worktree isolation per node; each attempt's work is captured as a binary patch you can inspect and apply from the UI.
- **Run Workspace** — a Narrative-first **Conversation** makes every node's answer, decision, verification, and failure easy to scan. **Timeline** preserves the virtualized raw categories, node/role/search filters, and full replay from the durable event log.
- **Health & diagnostics** — read-only server, provider, workspace, run, verification, and evidence-continuity findings with safe Setup, inspect, redacted-log, and debug-bundle actions. CLI detection is never presented as proof of sign-in.

## Verification (evidence plane)

Workspaces can define a verification command such as `npm test` and an optional timeout (600 seconds by default). Worktree-isolated candidates with a non-empty patch run that command after artifact capture; the normalized pass, fail, error, or skipped result and full log are persisted with the run. A gated stage can enable `requireVerified`, which retries failed checks when no candidate passed, subject to the existing retry budget.

The UI and generated Markdown report distinguish generated, reviewed, advanced, and verified work. A degraded or unverified advance is labeled, never hidden. Open **Report** in the run panel or request `GET /api/runs/:id/report` for a PR- and retrospective-ready record of outcomes, handoffs, decisions, provider CLI versions, usage, patches, and verification evidence. The builtin **Pipeline: Implement → Test → Review** preset provides the shortest evidence-gated production line.

## Steering

While a run is active, enter a new instruction in the run panel. **Interrupt** (the default) terminates the active candidate process trees, preserves their partial logs and patches, runs the new instruction through the normal evidence path, then records a gate-style review that decides whether to redo the interrupted stage, continue, or abort. **Queue** waits for the next stage boundary and applies the instruction without killing current work. Steering is FIFO, capped at eight messages per run, and remains deterministic when the orchestrator is disabled. It never uses a PTY or writes to a running child's stdin.

## Debug bundle

Choose **Debug** beside **Report**, or use the read-only **Health** drawer, to download one `mat-debug-<runId>.zip`. It contains the full run snapshot, events, diagnostic journal, Markdown report, raw adapter output, patches, verification logs, runtime/provider versions, and the tail of the server diagnostic log. Browser errors are also reported best-effort to the server journal; environment variable values are never intentionally recorded.

## Quickstart

Requirements: Node.js ≥ 20, Git ≥ 2.32 recommended (older Git falls back to plain `git apply --check`), plus whichever agent CLIs you want: `claude`, `codex`, `grok`, `agy`.

```sh
npm install
npm run build
npm start                      # serves web UI + API on http://127.0.0.1:7788
# options: --port N --host H --data-dir DIR --token SECRET
```

Open the UI, choose **Projects** to add a workspace (absolute path), return to **Launch**, pick a builtin workflow (Planning / Build / Review / Pipeline), write the task, and Start. Use **Customize** only when you need to change stages or agent bindings.

Dev mode: `npm run dev` (vite + API with hot reload). Tests: `npm test`. Typecheck: `npm run typecheck`. Version contract: `npm run verify:version`. Built-server evidence suite: `npm run evidence` after `npm run build`.

## Desktop app

Install desktop builds from the repository's GitHub Releases page. The desktop app requires Node.js ≥ 20 on `PATH`; set `MAT_NODE` to the path of a specific compatible Node.js binary if needed.

- Windows: download the `-setup.exe` (NSIS) or `.msi` and run it. The WebView2 runtime is preinstalled on Windows 10/11, and the installer bootstraps it if missing. Install Node.js ≥ 20 with `winget install OpenJS.NodeJS.LTS`; Git for Windows is also required for worktree isolation features. Set `MAT_NODE` to the path of a specific `node.exe` if needed.
- Debian/Ubuntu: download the `.deb`, then run `sudo apt install ./file.deb`.
- Other Linux distributions: download the `.AppImage`, run `chmod +x ./Multi-AI-Terminal*.AppImage`, then launch it. RPM packages are also provided.
- macOS: open the downloaded `.dmg` and copy the app to Applications. Version 1 builds are unsigned and not notarized, so on first launch right-click Multi-AI Terminal and choose **Open** to pass Gatekeeper.

The desktop shell runs the exact same bundled server on an ephemeral `127.0.0.1` port and keeps data in `~/.multi-ai-terminal/`, just like the web-served build. To build the desktop resources locally, run `npm run build` followed by `npm run desktop:bundle`; `npm run desktop:build` additionally requires the Rust and native Tauri build prerequisites.

When adding a workspace, desktop builds provide a native **Browse…** folder picker. Pure-browser use keeps the manual absolute-path field and does not load the desktop dialog integration.

## Provider setup

Unavailable providers expose **Setup** in the agent palette. An install starts only after an explicit click and uses a fixed server-side recipe: npm global installs for Claude Code, Codex, and Grok; `winget` for Antigravity on Windows; and a displayed, copyable manual command for Antigravity elsewhere. No CLI is bundled or downloaded implicitly. Provider licenses remain independent, the upstream package manager supplies current releases, and each CLI may still require its own sign-in.

MAT augments child-process `PATH` with existing well-known CLI locations: `%LOCALAPPDATA%\Antigravity` and `%APPDATA%\npm` on Windows, or `~/.local/bin`, `/usr/local/bin`, and `/opt/homebrew/bin` elsewhere. This lets the desktop server discover common user-level installs without inheriting environment-variable values into diagnostics.

## Provider sign-in & parallel sessions

Some Codex authentication failures are caused by concurrent CLI sessions racing rotation of a single-use OAuth refresh token. MAT spaces launches of the same real provider at least 1.5 seconds apart to reduce the race, including orchestrator launches, but this cannot make upstream token rotation atomic. See [openai/codex#9634](https://github.com/openai/codex/issues/9634) and [openai/codex#15502](https://github.com/openai/codex/issues/15502).

The durable options are API-key authentication or serial provider usage. Codex supports API-key login, and Claude Code honors `ANTHROPIC_API_KEY`. If an OAuth refresh token has already been revoked, sign out and back in with that CLI first; for Codex, run `codex logout && codex login`.

When a real provider fails with a recognized sign-in error, its node card shows multi-line amber guidance with the verified command, its provider chip gains an `auth` badge, and Setup exposes a copyable **Sign in** block. The composer warns before another run uses that provider without blocking it; a later successful node clears the alert.

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

`~/.multi-ai-terminal/` (override with `--data-dir` / `MAT_DATA_DIR`): `workspaces.json`, `workflows/*.json`, `runs/<runId>/run.json` + `events.jsonl` + `raw/*.jsonl` (environment-value-sanitized CLI output per attempt) + `artifacts/*.patch` + `artifacts/*.verify.log`. Retention: last 100 runs per workspace, worktrees/branches pruned on delete.

## Docs

- [SPEC.md](./SPEC.md) — the engineering contract (v1.4)
- [docs/project-audit-2026-07-20.md](./docs/project-audit-2026-07-20.md) — current hardening record and ordered continuation backlog
- [docs/spec-review-panel.md](./docs/spec-review-panel.md) — 4-model spec review record
- [docs/code-review-panel.md](./docs/code-review-panel.md) — 4-model code review record (25 findings fixed, 3 refuted)

Built by a 4-model panel process: spec + code review by Claude Fable 5, Codex GPT-5.6-sol, Gemini 3.1 Pro, and Grok 4.5; implementation by parallel Codex workers in isolated git worktrees.

## Known limitations (v1)

- Grok's streaming JSON emits no tool events — grok nodes show thinking/text only; digests report tool-count "n/a".
- Antigravity (`agy`) has no headless JSON mode — plain-text stream, no session resume (orchestrator re-briefs each gate).
- After a machine reboot, crash recovery kills stale process groups by persisted PID; PID-recycling risk is accepted.
- Event ring keeps 20k events in browser memory; older history pages in from the server with an explicit trim notice.
- On Windows, process termination uses `taskkill /T /F` (forced tree kill); if node exits on its own first, detached grandchildren are reaped by the stale-PID sweep on next server start.
