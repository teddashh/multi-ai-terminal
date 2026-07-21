# Handoff — Multi-AI Terminal (MAT)

Release target v0.2.0; updated 2026-07-21 for the v1.4 evidence-workbench release snapshot. Audience: the next implementer (a coding agent or human) taking over development. Published state and working-tree state are distinguished below. When this file disagrees with the code, the code wins — then fix this file.

## What this is

MAT is a desktop workbench that orchestrates **headless CLI coding agents** (claude, codex, grok, agy, plus a deterministic `mock`) through declarative multi-stage workflows: parallel fan-out per stage, an LLM orchestrator gating stage transitions, verification contracts producing evidence, handoff context between stages, mid-run steering, and exportable debug bundles. UI is React in a Tauri v2 shell; the server is Fastify driving child processes. **No PTY by design** — adapters speak each CLI's headless/JSON mode only.

The owner and sole user is Ted Huang (`teddashh/multi-ai-terminal` on GitHub). He runs Windows daily; the dev box is Linux. The product thesis (roundtable consensus, 2026-07): the moat is **evidence and handoff quality** — what an agent proved, what the next agent receives — not UI breadth.

## State at handoff

- v0.1.9 is the last previously released version. Accurate release history: v0.1.0 predates Windows packaging and has Linux + macOS artifacts with no notes; v0.1.1–v0.1.3 have all four platforms but no notes; v0.1.4–v0.1.9 have four-platform artifacts and bilingual notes.
- The manifests report **0.2.0** and this snapshot packages the **v1.4 evidence-workbench UX slice**. It replaces the four equal-weight columns with a navigation rail, persistent Launchpad, activity inspector, and flexible Run Workspace; adds progressive launch setup, Conversation/Timeline evidence views, shared live/replay selection and node focus, honest Health diagnostics, and visible evidence-continuity recovery. GitHub remains authoritative for whether the tag and public release have completed.
- CI runs on ubuntu + windows: version sync → build → tests → typecheck → Linux evidence suite → real-browser smoke. The v0.2.0 release snapshot passed version sync, production build, **47 files / 317 tests**, full typecheck, all four evidence instruments, and the real-Chromium smoke locally on Linux on 2026-07-20; fresh remote Linux/Windows CI is still required before publication.
- Release themes, latest first:
  - **v0.2.0** evidence workbench: navigation rail + Launchpad + activity inspector, progressive launch setup, Conversation-first evidence reading with raw Timeline fallback, replay/node focus, honest Health diagnostics, visible catch-up recovery, and whole-project security/engine/release hardening.
  - **v0.1.9** auth visibility: failed nodes scan output for auth failures → `errorReason` with a `Fix:` sign-in line; provider chips get an amber `auth` badge + Setup "Sign in" block; composer warns pre-run; reports carry failure reasons.
  - **v0.1.8** provider onboarding: model combobox (WebView2 renders `<datalist>` useless — do not go back), Tauri native folder picker, one-click CLI install from fixed recipes, augmented PATH discovery, 1.5 s same-provider spawn stagger.
  - **v0.1.7** steering + debug plane: BAT-style interrupt/queue steers with review, diag journal, debug-bundle zip export.
  - **v0.1.6** evidence plane: verification contracts, `requireVerified` gates, handoff capture, run reports.
- Independent release verifiers live in `tools/evidence/` (see its README). Every release since v0.1.6 was verified by running them against the extracted `.deb` before the final report.

## UX references — principles, not scope

The v1.4 work checked the latest heads available on 2026-07-20 for [TempoTerm](https://github.com/mukiwu/tempo-term) (`0bed0f9`), [Better Agent Terminal](https://github.com/tony1223/better-agent-terminal) (`b09639c`), and MAT's predecessor [multi-ai-chat-desktop](https://github.com/teddashh/multi-ai-chat-desktop) (`4e98c06`, the v1.7.0 merge). They are hierarchy/status/focus interaction references, never architecture or roadmap templates:

- **TempoTerm:** borrow project-first navigation, glanceable agent/worktree status, stable docked panels, and actions placed next to the context they affect. Do not import its PTY, editor, file/Git/SSH, split-pane, or general IDE breadth.
- **Better Agent Terminal:** borrow a dominant working surface with subordinate workspace/settings panes, presets for the common path, compact status that answers “what is happening?”, and technical detail that expands on demand. Do not import terminal aggregation, SDK session semantics, remote clients, pause/resume, or its feature catalog.
- **multi-ai-chat-desktop:** preserve the owner's familiar conversation-first hierarchy, visible workflow controls, readable results, replay/diagnostic affordances, and streaming UI that does not steal focus or let stale async responses replace a newer choice. Do not reuse its WebView automation runtime or broaden MAT into parallel chat windows.

The synthesis is: adopt the hierarchy/status/focus mental model so setup, diagnosis, and evidence reading feel direct and predictable while keeping MAT headless. Product depth still means trustworthy evidence and handoff, not more panes or terminal emulation.

## Repo map (the load-bearing parts)

- `shared/` — zod contracts shared by server and web. **Schemas are strict; evolve them additively** (new fields optional) or old clients/tests break.
- `server/src/spawn.ts` — `augmentedPathEnv()` appends existing well-known CLI dirs to PATH (win32: `%LOCALAPPDATA%\Antigravity`, `%APPDATA%\npm`; unix: `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`), cached per process, cleared by `clearAugmentedPathCache()` after installs. Also the **cross-spawn bypass**: `options.shell ? spawnChild : crossSpawn` — cross-spawn fakes ENOENT on exit-1 under shell on Windows.
- `server/src/adapters/base.ts` — spawn/probe plumbing; `providerSpawnSlot()` per-provider promise chain spacing same-provider spawns ≥1500 ms (mock exempt); `detectAuthFailure()` pattern-scans the last 4 KB of output and composes `errorReason` + `Fix: <signInCommand>` + the CLI's own instruction line (api-key **values** filtered out).
- `server/src/adapters/{claude,codex,grok,agy,mock}.ts`, `registry.ts` — per-CLI adapters; registry attaches `installable`/`manualCommand`/`authAlert`/`signInCommand` to `ProviderInfo`. `mock.ts` honors the `MOCK_AUTHFAIL` marker (emits grok-style auth text, exit 1) for tests/instruments.
- `server/src/providers/install.ts` — fixed install recipes per provider/platform. `providers/auth.ts` — auth-alert store + verified sign-in command table.
- `server/src/engine/` — `runManager` → `stageRunner` (stages, gates, steers; passes `steerPending` into node context) → `nodeRunner` (spawns via adapter, keeps a 4096-char `outputTail`, auth detection on failure, clears provider alert on success); `verify.ts` runs verification contracts; `report.ts`; `debugBundle.ts`; `worktree.ts` isolation; `steer.ts`.
- `server/src/diag.ts` — structured diag journal. **Never log environment-variable values** anywhere, including here.
- `web/src/app/App.tsx` — boot/API and active-run WebSocket lifecycle, global connection/run status, Abort, and the Health entry point. Transport status and evidence completeness are different signals; do not collapse them into one green/red light.
- `web/src/app/AppShell.tsx` — the load-bearing v1.4 geometry: 52 px rail → persistent Launchpad → persistent activity inspector → flexible Run Workspace. Launchpad and inspector collapse by hiding their inner content, **not by unmounting their trees**, so drafts and dialogs survive. Independent widths live in `mat-shell-layout-v2`, persist after a 120 ms debounce, have keyboard-accessible dividers, and are fitted to retain a 320 px workspace. Keep the outer grid cells present when collapsed; removing them changes CSS grid auto-placement and can hide the workspace.
- `web/src/app/RunWorkspace.tsx` — the only owner of the viewed-run selector and replay hydration for Conversation and Timeline. It keeps `activeRunId` (subscription/control) separate from `viewedRunId` (what the user reads), shares node focus/presets across evidence views, and uses generation guards so a stale run/history request cannot replace a newer selection.
- `web/src/app/store.ts` — zustand state plus bounded live evidence recovery. **Selectors must be stable** (no fresh `[]`/objects in selectors — caused the v0.1.0–v0.1.3 React #185 black screen). It keeps a 20,000-event UI ring, buffers live arrivals during REST backfill, preserves the earliest unresolved sequence gap, exposes `recovering`/`incomplete`/Retry, and refreshes providers whenever a run turns terminal.
- `web/src/panels/workflow/WorkflowPanel.tsx` — common-path launch composer: mode, provider readiness, task, and Start stay visible; advanced stage/orchestrator/agent editing is opt-in in `SideDrawer`. `ModelEditor` is a WebView2-safe combobox and **must never auto-collapse** its custom input: a custom value can pass through a listed model while being typed, e.g. `sonnet` on the way to `sonnet[1m]`.
- `web/src/panels/run/RunPanel.tsx` — persistent activity inspector and node/action evidence. Counted instances use the shared derived `#1`/`#2` display label without changing persisted identity. Failed-node `errorReason` renders **multi-line amber** — the `Fix:` line is the whole point, don't truncate it.
- `web/src/panels/narrative/{NarrativePanel,narrativeLogic}.tsx` — default readable evidence projection. It may join only adjacent identity-compatible continuations/tool halves, retains every source event, exposes source sequence ranges, and renders gaps explicitly.
- `web/src/panels/stream/{StreamPanel,streamLogic}.tsx` — raw Timeline. Filtering/search must retain source `id`/`seq`; tool use/result and duplicate prompts are adjacent-only visual groups and must expand back to monotonic source order. Delayed tool results never move across intervening evidence.
- `web/src/panels/health/` + `web/src/components/SideDrawer.tsx` — read-only, scope-grouped troubleshooting and safe redacted exports in an accessible focus-trapped drawer. CLI discovery never means “signed in”; Health does not retry, kill, or apply run mutations.
- `web/src/panels/workspace/` — project selection; Browse… uses the Tauri dialog plugin, gated on `'__TAURI_INTERNALS__' in window`.
- `desktop/src-tauri/` — Tauri v2 shell. A plugin needs all three: `Cargo.toml` dep, `.plugin(...init())` in `main.rs`, permission in `capabilities/default.json`. **No Rust toolchain on the dev box** — Rust changes are validated only by the release build; keep them minimal and double-checked.
- `tools/evidence/repro-v01{6,7,8,9}.mjs` — black-box verifiers, deliberately independent of the vitest suites; `npm run evidence` runs all four with a shared expected version.
- `scripts/verify-version.mjs` — checks all six authoritative product versions, npm lock metadata, and an optional release tag.
- `SPEC.md` — the reviewed product spec. `docs/` — review-panel records plus `project-audit-2026-07-20.md`, the ordered continuation backlog.

## Invariants — do not break

**Security (user-facing trust):**
1. Provider installs run **only** from an explicit user click, using the **fixed server-side recipes** in `providers/install.ts`. User input never reaches a command line. Nothing is bundled or downloaded implicitly (unix agy shows a `manualCommand` for the user to run themselves).
2. Never log values **read from the environment** — not in diag, errors, bundles, or transcripts. Sink redaction removes every exact-field match and distinctive embedded machine value, plus credential-bearing values at every length; trusted engine constants and protocol enums remain intact when a host value merely coincides. The auth instruction passthrough accepts only canonical sign-in instructions.
3. MAT never reads or writes provider credential stores. When users blame MAT for expired logins, the real cause is upstream (see Known issues).

**Determinism:** the `mock` provider stays exempt from real-provider behaviors (spawn stagger, auth alerts/`errorReason`) so tests and instruments stay fast and deterministic. The `MOCK_AUTHFAIL` instrument depends on this.

**Contracts:** `shared/` schema changes are additive-only. All product-version manifests and npm lock metadata must agree; `npm run verify:version` enforces this and release builds also compare the tag.

**UI regressions with history:** stable zustand selectors; `min-h-0` on every flex/grid ancestor of a scroll pane; BAT-style follow mode (auto-follow disarms on wheel-up, re-arms at bottom); multi-line amber `errorReason`; no datalist; no ModelEditor auto-collapse.

**Live/replay evidence contract:** persisted `AgentEvent.seq` is authoritative and events are immutable. Conversation is a projection only: compatible adjacent continuations may become one block, but each source event appears exactly once and gaps remain visible. Timeline retains raw events and permits only reversible adjacent visual grouping. Live WebSocket gaps and initial/reconnect catch-up set a visible integrity state, backfill through REST, merge/deduplicate by sequence, and become `incomplete` with explicit Retry on failure. A transport connection badge does not prove evidence continuity. Historical selection never changes the active subscription, replay requests carry generation guards, and the server/debug bundle remain the complete record when the browser ring trims old rows.

## Release playbook

1. Bump the version in the **six authoritative files**: `package.json`, `server/package.json`, `web/package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, `server/src/version.ts`. Then run `npm install --package-lock-only --ignore-scripts` to synchronize the root/server/web version metadata in `package-lock.json`. Leave `Cargo.lock` absent under the current policy — `release.yml` builds without `--locked`.
2. Run `npm run verify:version`, commit, push, and watch `ci.yml` for the pushed sha until **both** platforms are green.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` → `release.yml` verifies the tag, reruns the Linux quality/evidence gates, builds four platform jobs, and creates a **draft** release with artifacts.
4. Attach bilingual notes to the draft (English then 繁體中文, same structure; voice: what changed and why it matters, driven by the field evidence that motivated it): `gh release edit vX.Y.Z --notes-file <notes.md>`.
5. Verify the draft artifact: `gh release download vX.Y.Z --pattern '*.deb'` → `dpkg-deb -x` → `MAT_ROOT="<extracted>/usr/lib/Multi-AI Terminal" MAT_EXPECT_VERSION=X.Y.Z npm run evidence`. The path contains a space — quote it. All checks must pass.
6. Publish only after notes and artifact verification: `gh release edit vX.Y.Z --draft=false`.
7. Definition of done: commit → CI green both platforms → tag/version verified → all expected artifacts in draft → bilingual notes → artifact instruments green → publish → report.

Dev-box quirks: prefix `git push`/`gh` with `env -u LD_LIBRARY_PATH`; `gh run view`/API calls occasionally hit TLS handshake timeouts — retry up to 3× before believing a failure. Local browser smoke needs `CHROME_PATH=~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome npm run smoke:browser`.

## Windows/CI portability rules (each cost real debugging time)

- New tests that spawn processes or cycle worktrees need explicit timeouts (`, 30_000`) and deadline-based waits — vitest's 5 s default fails only on Windows CI.
- When injecting an `exists`/path predicate into tests, use **pure-POSIX fixture paths** and fake fs — `join()` produces backslashes on Windows while production template strings produce forward slashes; string equality silently diverges (`existsSync` tolerates mixed separators, hiding it locally).
- Compare workspace paths against the canonical path returned by the store/API, not the raw `mkdtemp` string — Windows can create the fixture through an 8.3 path such as `RUNNER~1` and resolve it back to the long user name.
- Fixture repositories that assert patch/file bytes must set local `core.autocrlf=false` — otherwise the Windows runner can rewrite LF to CRLF during `git apply` even though the patch is correct.
- Recursive removals: `rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })` — Windows holds file locks briefly.
- `.cmd` shims need `shell: true` to spawn; that path must keep using raw `spawn` (not cross-spawn) or exit-1 becomes a fake ENOENT.
- jsdom lies about rendering — the real-browser smoke (`smoke:browser`) exists because jsdom hid a total black screen for four releases. Never remove it from CI.

## Known issues & upstream context

- **codex OAuth refresh tokens are single-use**; parallel same-account sessions race the rotation and the whole grant gets revoked ("refresh token was revoked") — upstream openai/codex#9634, #6498, #15502. MAT's fan-out amplified this (two codex nodes 93 ms apart in a field bundle) → the 1.5 s `providerSpawnSlot` stagger. Durable fix for users: API-key auth (`codex` API-key login, `ANTHROPIC_API_KEY`).
- Verified sign-in commands (also in `providers/auth.ts`): codex `codex logout && codex login`; claude `claude` then `/login` inside the session; grok `grok login` / `grok login --device-code` (headless) / `XAI_API_KEY`; agy just `agy` (auto sign-in), `/logout` to clear.
- WebView2 (Windows) renders `<datalist>` as unusable — the reason ModelEditor is a select+custom-input combobox.

## Deferred scope — do not build unasked

Explicitly deferred by Ted until he asks: pause/resume, human-approval nodes, steer-time agent picker, adapter live contract tests, multi-pane/canvas layouts, i18n of the UI. No PTY/interactive-terminal mode — headless only. UI breadth stays deprioritized in favor of evidence/handoff depth.

## Working with Ted

- Reply to him in **繁體中文**; repo code, comments, commits, and docs stay in English. Release notes bilingual.
- He expects production-grade, single-pass work ("一次到位") and reviews everything himself before considering it done.
- The feedback loop that works: he sends a `mat-debug-*.zip` bundle from the app → diagnose from its diag journal/transcripts → every fix traceable to bundle evidence → same-day release. Two bundles produced v0.1.8 and v0.1.9 this way. Protect the debug-bundle export path — it is the project's eyes.
