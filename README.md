# Multi-AI Terminal

**English** · [繁體中文](README.zh-TW.md)

A local workbench that runs staged multi-agent coding workflows across headless Claude Code, Codex, Grok, Antigravity, and OpenRouter runtimes, with an orchestrator agent gating each stage.

**Project page:** https://teddashh.github.io/multi-ai-terminal/

Drag agents onto workflow stages, let a real LLM orchestrator gate each stage, and watch every agent's output stream into one categorized, replayable feed. OpenRouter models run with Codex as their runtime.

Successor to [multi-ai-chat-desktop](https://teddashh.github.io/multi-ai-chat-desktop/): instead of scraping web chats, every agent is driven through a real headless CLI, app-server, or SDK runtime whose stream is normalized into one durable evidence schema.

The latest release is [**v0.2.10**](https://github.com/teddashh/multi-ai-terminal/releases/tag/v0.2.10) (July 23, 2026). It added OpenRouter through Codex as the runtime, a shared headless manager for Grok and Agy, and one provider-neutral event contract.

## How it works

- **Projects and Launch**: each workspace points at a directory (git-aware). The icon-and-text rail switches between project selection and the launch composer without losing drafts. Common mode, readiness, and task settings stay visible; advanced stage editing lives under **Customize**.
- **Workflows**: ordered stages, each holding agent slots. Drag agents from the advanced palette; several instances of the same provider are allowed, up to 12 agents per stage. Per slot: model, reasoning effort, permission tier, prompt template, and count.
- **Orchestrator**: a real CLI agent (any provider) that receives a digest of each gated stage's candidates and answers with a strict-JSON gate decision: advance, retry (targeting specific nodes, with a prompt addendum), or abort. Budget caps are deterministic. If the answer cannot be parsed, the stage advances and is marked degraded.
- **Stage isolation**: optional git-worktree isolation per node. Each attempt's work is captured as a binary patch you can inspect and apply from the UI.
- **Run workspace**: **Conversation** comes first and makes every node's answer, decision, verification, and failure easy to scan. **Timeline** keeps the raw event categories, virtualized scrolling, node, role, and search filters, and full replay from the durable event log.
- **Health and diagnostics**: server, provider, workspace, run, verification, and evidence-continuity findings, with safe Setup, provider recheck, inspect, redacted-log, and debug-bundle actions. Detecting a CLI is never presented as proof of sign-in.
- **Language and themes**: follows the system language or switches between English and Traditional Chinese, with persistent Midnight, Daylight, and AI-Sister Commemorative Edition themes.

## Verification (evidence plane)

Workspaces can define a verification command such as `npm test` and an optional timeout (600 seconds by default). Worktree-isolated candidates with a non-empty patch run that command after artifact capture; the normalized pass, fail, error, or skipped result and the full log are saved with the run. A gated stage can enable `requireVerified`, which retries failed checks when no candidate passed, within the existing retry budget.

The UI and the generated Markdown report distinguish generated, reviewed, advanced, and verified work. A degraded or unverified advance is labeled, never hidden. Open **Report** in the run panel or request `GET /api/runs/:id/report` for a record that is ready for a PR or a retrospective: outcomes, handoffs, decisions, provider CLI versions, usage, patches, and verification evidence. The builtin **Pipeline: Implement → Test → Review** preset is the shortest evidence-gated production line.

## Steering

While a run is active, enter a new instruction in the run panel. **Interrupt** (the default) terminates the active candidate process trees, keeps their partial logs and patches, runs the new instruction through the normal evidence path, then records a gate-style review that decides whether to redo the interrupted stage, continue, or abort. **Queue** waits for the next stage boundary and applies the instruction without killing current work. Steering is first in, first out, capped at eight messages per run, and stays deterministic when the orchestrator is disabled. It never uses a PTY or writes to a running child's stdin.

## Debug bundle

Choose **Debug** beside **Report**, or use the read-only **Health** drawer, to download one `mat-debug-<runId>.zip`. It contains the full run snapshot, events, diagnostic journal, Markdown report, raw adapter output, patches, verification logs, runtime and provider versions, and the tail of the server diagnostic log. Browser errors are also reported to the server journal on a best-effort basis. Environment variable values are never intentionally recorded.

## Quickstart

Requirements: Node.js 20 or newer, and Git 2.32 or newer recommended (older Git falls back to a plain `git apply --check`). You also need the runtimes for the providers you use: Claude and Codex can use MAT-managed, pinned runtimes; Grok uses `grok`; Antigravity uses `agy`. OpenRouter has no CLI of its own: it needs the Codex runtime and `OPENROUTER_API_KEY` in MAT's environment. In the editor, choose an OpenRouter model first and then a version; MAT saves and sends that version's exact OpenRouter request slug.

```sh
npm install
npm run build
npm start                      # web UI and API on http://127.0.0.1:7788
# options: --port N --host H --data-dir DIR --token SECRET
# or set MAT_PORT, MAT_HOST, MAT_DATA_DIR, MAT_TOKEN
```

Open the UI, choose **Projects** to add a workspace (absolute path), return to **Launch**, pick a builtin workflow (Planning, Build, Review, or Pipeline), write the task, and press **Start**. Open **Customize** only when you need to change stages or agent bindings.

Use **Language · Theme** in the top bar to override the system language or pick one of the three themes. Both choices persist across restarts.

Dev mode: `npm run dev` (Vite and the API with hot reload). Tests: `npm test`. Typecheck: `npm run typecheck`. Version contract: `npm run verify:version`. Built-server evidence suite: `npm run evidence` after `npm run build`.

## Desktop app

Download a build from [GitHub Releases](https://github.com/teddashh/multi-ai-terminal/releases). The desktop app needs Node.js 20 or newer on `PATH`; set `MAT_NODE` to a specific compatible Node.js binary if needed. The installers are not code-signed or notarized.

- Windows: download `Multi-AI.Terminal_<version>_x64-setup.exe` (NSIS) or the `.msi` and run it. Because the installers are unsigned, SmartScreen may ask you to confirm first. The WebView2 runtime ships with Windows 10 and 11, and the installer bootstraps it if missing. Install Node.js 20 or newer with `winget install OpenJS.NodeJS.LTS`; Git for Windows is also required for worktree isolation. Set `MAT_NODE` to a specific `node.exe` if needed.
- Debian and Ubuntu: download the `.deb`, then run `sudo apt install ./Multi-AI.Terminal_<version>_amd64.deb`.
- Other Linux distributions: download the `.AppImage`, run `chmod +x ./Multi-AI.Terminal_*_amd64.AppImage`, then launch it. An `.rpm` package is also provided.
- macOS: download the `.dmg` for your Mac (`aarch64` for Apple silicon, `x64` for Intel), open it, and copy the app to Applications. On first launch, right-click Multi-AI Terminal and choose **Open**. On macOS 15 or later, try to open it once, then choose **Open Anyway** under **System Settings > Privacy & Security**.

The desktop shell runs the same bundled server on a random `127.0.0.1` port and keeps data in `~/.multi-ai-terminal/`, just like the web-served build. To build the desktop resources locally, run `npm run build` followed by `npm run desktop:bundle`; `npm run desktop:build` also needs Rust and the native Tauri build prerequisites.

When adding a workspace, desktop builds provide a native **Browse…** folder picker. In a plain browser you type the absolute path, and the desktop dialog integration is not loaded.

## Agent-driven launch (agent-ready source release)

This repository can be driven by coding agents such as Claude Code and Codex. [`agent-release.json`](agent-release.json) is a machine-readable contract (validated against [`agent-release.schema.json`](agent-release.schema.json)) that declares the entrypoints, permissions, side effects, runtime states, and exit codes of the source-web lane. Matching skills ship in the repo under `.claude/skills/launch-multi-ai-terminal/` and `.agents/skills/launch-multi-ai-terminal/`. The skills are explicit-only: an agent may use them only when you ask, never implicitly.

```sh
npm run agent:doctor -- --json           # prerequisites (Node 20+, npm); never installs anything
npm run agent:launch -- --wait --json    # npm ci if needed, build, start on a free 127.0.0.1 port
npm run agent:status -- --json           # state + URL; ready only after "[MAT_AGENT] READY url=..."
npm run agent:stop -- --json             # stops only the identity-verified launcher process tree
npm run agent:audit -- --json            # declared permissions/side effects vs observed artifacts
```

The lane is source-web only: no Rust toolchain, no installers, no release-asset downloads. Lifecycle records stay in the gitignored `.agent-runtime/` directory. Lifecycle scripts never read provider credentials, and the skills are forbidden from driving the launched server's provider install, update, or sign-in APIs on your behalf. Do not run this lane while the installed desktop app is open: both use the same data directory (`MAT_DATA_DIR` or `~/.multi-ai-terminal/`), and two servers over one data directory race its stores.

## Provider setup

On first run, the desktop app quietly bootstraps missing supported Claude and Codex managed runtimes, including the Codex runtime that OpenRouter reuses. These artifacts are catalog-pinned, integrity-verified, and written only under `<dataDir>/runtimes/`; MAT does not install `@latest` globally or modify the host `PATH`. Unavailable providers still show **Setup** as a recovery path, and for provider-specific fixed recipes where no managed artifact exists. Those recipes accept no command input, and each provider's license and sign-in remain independent.

Automatic bootstrap and Setup both rerun runtime and provider discovery when installation finishes; Setup also shows elapsed time and keeps completion and restart guidance visible. **Retry detection** clears MAT's local PATH and version caches without reinstalling anything. Windows version probes give cold CLI shims 15 seconds to start; transient failures are cached for only two seconds, while successful versions stay cached for ten minutes.

MAT appends existing well-known CLI locations to the child-process `PATH`: on Windows `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`, `%LOCALAPPDATA%\Antigravity`, `%APPDATA%\npm`, and `%USERPROFILE%\.local\bin`; elsewhere `~/.local/bin`, `/usr/local/bin`, and `/opt/homebrew/bin`. Directories that do not exist are skipped. This lets the desktop server find common user-level installs without copying environment-variable values into diagnostics.

## Provider sign-in and parallel sessions

Some Codex authentication failures come from concurrent CLI sessions racing the rotation of a single-use OAuth refresh token. MAT spaces launches of the same real provider at least 1.5 seconds apart to reduce the race, orchestrator launches included, but this cannot make upstream token rotation atomic. See [openai/codex#9634](https://github.com/openai/codex/issues/9634) and [openai/codex#15502](https://github.com/openai/codex/issues/15502).

The durable options are API-key authentication or serial provider use. Codex supports API-key login, and Claude Code honors `ANTHROPIC_API_KEY`. If an OAuth refresh token has already been revoked, sign out and back in with that CLI first; for Codex, run `codex logout && codex login`.

When a real provider fails with a recognized sign-in error, its node card shows multi-line amber guidance with the verified command, its provider chip gains an `auth` badge, and Setup exposes a copyable **Sign in** block. The composer warns before another run uses that provider without blocking it; a later successful node clears the alert.

OpenRouter authentication is environment-only: set `OPENROUTER_API_KEY` before starting MAT and restart MAT after changing it. MAT reports only whether the variable is present; it never exposes or saves its value.

## Providers and runtime paths

| Provider | Runtime / transport | Stream | Notes |
|---|---|---|---|
| claude | Agent SDK driving the resolved `claude` runtime | full (text, thinking, tools, usage) | persistent session runtime; an explicit legacy CLI mode remains |
| codex | persistent `codex app-server` JSON-RPC/JSONL controller | full (thinking, tools, usage) | one shared controller owns resumable threads |
| grok | `grok --prompt-file F --output-format streaming-json`, behind a FIFO manager | thinking and text only (tools run silently) | grok 0.2.93 or newer: do not pass `-p` with `--prompt-file` |
| agy | `agy -p "PROMPT" --model "Gemini 3.1 Pro (High)" --print-timeout 45m`, behind a FIFO manager | plain text | model is the display name; no JSON mode or resume |
| openrouter | no OpenRouter CLI; persistent Codex app-server with an isolated OpenRouter config | full where the selected model supports it | requires `OPENROUTER_API_KEY`; pick a model, then a version; the exact version slug is sent |
| mock | in-process | scripted | deterministic; `MOCK_REPLY:` echo mode for tests |

Permission tiers per slot: `safe` (read-only), `auto` (accept edits), and `full` (bypass sandbox), each mapped to the runtime's native policy (SPEC §4.6).

## Trust model

Binds `127.0.0.1` by default. `--host 0.0.0.0` exposes the API and UI to your network, so set `--token` as well (REST bearer token plus WebSocket query token). MAT does not require a token on a non-loopback host; that choice is yours. Anyone who can reach the port can run arbitrary CLI agents in your workspaces, so treat it accordingly (Tailscale-only exposure recommended).

## Data

`~/.multi-ai-terminal/` (override with `--data-dir` or `MAT_DATA_DIR`): `workspaces.json`, `workflows/*.json`, `runs/<runId>/run.json`, `events.jsonl`, `raw/*.jsonl` (CLI output per attempt, with environment values removed), `artifacts/*.patch`, and `artifacts/*.verify.log`. Retention: the last 100 runs per workspace; worktrees and branches are pruned on delete.

## Docs

- [SPEC.md](SPEC.md): the engineering contract (v1.5, including BAT runtime alignment)
- [docs/project-audit-2026-07-20.md](docs/project-audit-2026-07-20.md): hardening record and ordered continuation backlog
- [docs/spec-review-panel.md](docs/spec-review-panel.md): 4-model spec review record
- [docs/code-review-panel.md](docs/code-review-panel.md): 4-model code review record (25 findings fixed, 3 refuted)

Built through a 4-model panel process: spec and code review by Claude Fable 5, Codex GPT-5.6-sol, Gemini 3.1 Pro, and Grok 4.5; implementation by parallel Codex workers in isolated git worktrees.

## Credits

- [Better Agent Terminal](https://github.com/tony1223/better-agent-terminal) is the architecture reference for provider-runtime handling: a persistent `codex app-server` controller and Claude Agent SDK sessions. MAT is not a fork. It ports that pattern to a Node-only server and applies it to grok and agy as well.
- [TempoTerm](https://github.com/mukiwu/tempo-term) was a UI reference for project-first navigation and glanceable status.

## License

MIT © 2026 Ted Huang, see [LICENSE](LICENSE). The five AI-Sister character images in `web/src/assets/themes/ai-sister/` are not covered by the MIT License; see that directory's [NOTICE.md](web/src/assets/themes/ai-sister/NOTICE.md).

## Known limitations

- Grok's streaming JSON emits no tool events, so grok nodes show thinking and text only, and digests report the tool count as "n/a".
- Antigravity (`agy`) has no headless JSON mode: the stream is plain text and there is no session resume (the orchestrator re-briefs it at each gate).
- Desktop builds are not code-signed or notarized, and still need Node.js 20 or newer on `PATH` (or `MAT_NODE`).
- CI and the evidence suite use the mock provider; runs against real signed-in Codex, Claude, or OpenRouter accounts are not part of CI.
- After a machine reboot, crash recovery kills stale process groups by their saved PID; the risk of PID reuse is accepted.
- The event ring keeps 20,000 events in browser memory; older history pages in from the server with an explicit trim notice.
- On Windows, process termination uses `taskkill /T /F` (a forced tree kill). If node exits on its own first, detached grandchildren are reaped by the stale-PID sweep on the next server start.
