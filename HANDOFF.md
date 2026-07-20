# Handoff — Multi-AI Terminal (MAT)

Written 2026-07-20, at v0.1.9. Audience: the next implementer (a coding agent or human) taking over development. Everything here was true at commit time; when this file disagrees with the code, the code wins — then fix this file.

## What this is

MAT is a desktop workbench that orchestrates **headless CLI coding agents** (claude, codex, grok, agy, plus a deterministic `mock`) through declarative multi-stage workflows: parallel fan-out per stage, an LLM orchestrator gating stage transitions, verification contracts producing evidence, handoff context between stages, mid-run steering, and exportable debug bundles. UI is React in a Tauri v2 shell; the server is Fastify driving child processes. **No PTY by design** — adapters speak each CLI's headless/JSON mode only.

The owner and sole user is Ted Huang (`teddashh/multi-ai-terminal` on GitHub). He runs Windows daily; the dev box is Linux. The product thesis (roundtable consensus, 2026-07): the moat is **evidence and handoff quality** — what an agent proved, what the next agent receives — not UI breadth.

## State at handoff

- v0.1.9 released; tags v0.1.0–v0.1.9 all have 4-platform artifacts (macOS arm64/x64, Windows x64, Linux x64) and bilingual notes.
- CI green on ubuntu + windows: `npm ci && npm run build && npm test && npm run typecheck && npm run smoke:browser` (35 files / 226 tests at handoff).
- Release themes, latest first:
  - **v0.1.9** auth visibility: failed nodes scan output for auth failures → `errorReason` with a `Fix:` sign-in line; provider chips get an amber `auth` badge + Setup "Sign in" block; composer warns pre-run; reports carry failure reasons.
  - **v0.1.8** provider onboarding: model combobox (WebView2 renders `<datalist>` useless — do not go back), Tauri native folder picker, one-click CLI install from fixed recipes, augmented PATH discovery, 1.5 s same-provider spawn stagger.
  - **v0.1.7** steering + debug plane: BAT-style interrupt/queue steers with review, diag journal, debug-bundle zip export.
  - **v0.1.6** evidence plane: verification contracts, `requireVerified` gates, handoff capture, run reports.
- Independent release verifiers live in `tools/evidence/` (see its README). Every release since v0.1.6 was verified by running them against the extracted `.deb` before the final report.

## Repo map (the load-bearing parts)

- `shared/` — zod contracts shared by server and web. **Schemas are strict; evolve them additively** (new fields optional) or old clients/tests break.
- `server/src/spawn.ts` — `augmentedPathEnv()` appends existing well-known CLI dirs to PATH (win32: `%LOCALAPPDATA%\Antigravity`, `%APPDATA%\npm`; unix: `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`), cached per process, cleared by `clearAugmentedPathCache()` after installs. Also the **cross-spawn bypass**: `options.shell ? spawnChild : crossSpawn` — cross-spawn fakes ENOENT on exit-1 under shell on Windows.
- `server/src/adapters/base.ts` — spawn/probe plumbing; `providerSpawnSlot()` per-provider promise chain spacing same-provider spawns ≥1500 ms (mock exempt); `detectAuthFailure()` pattern-scans the last 4 KB of output and composes `errorReason` + `Fix: <signInCommand>` + the CLI's own instruction line (api-key **values** filtered out).
- `server/src/adapters/{claude,codex,grok,agy,mock}.ts`, `registry.ts` — per-CLI adapters; registry attaches `installable`/`manualCommand`/`authAlert`/`signInCommand` to `ProviderInfo`. `mock.ts` honors the `MOCK_AUTHFAIL` marker (emits grok-style auth text, exit 1) for tests/instruments.
- `server/src/providers/install.ts` — fixed install recipes per provider/platform. `providers/auth.ts` — auth-alert store + verified sign-in command table.
- `server/src/engine/` — `runManager` → `stageRunner` (stages, gates, steers; passes `steerPending` into node context) → `nodeRunner` (spawns via adapter, keeps a 4096-char `outputTail`, auth detection on failure, clears provider alert on success); `verify.ts` runs verification contracts; `report.ts`; `debugBundle.ts`; `worktree.ts` isolation; `steer.ts`.
- `server/src/diag.ts` — structured diag journal. **Never log environment-variable values** anywhere, including here.
- `web/src/app/store.ts` — zustand. **Selectors must be stable** (no fresh `[]`/objects in selectors — caused the v0.1.0–v0.1.3 React #185 black screen). Refreshes providers whenever a run turns terminal.
- `web/src/panels/` — `workflow/WorkflowPanel.tsx` (composer; `ModelEditor` combobox — **never auto-collapse** the custom input: a custom value can pass through a listed model while being typed, e.g. `sonnet` on the way to `sonnet[1m]`), `run/RunPanel.tsx` (node cards; failed-node `errorReason` renders **multi-line amber** — the `Fix:` line is the whole point, don't truncate to one line), `workspace/` (Browse… uses the Tauri dialog plugin, gated on `'__TAURI_INTERNALS__' in window`).
- `desktop/src-tauri/` — Tauri v2 shell. A plugin needs all three: `Cargo.toml` dep, `.plugin(...init())` in `main.rs`, permission in `capabilities/default.json`. **No Rust toolchain on the dev box** — Rust changes are validated only by the release build; keep them minimal and double-checked.
- `tools/evidence/repro-v01{6,7,8,9}.mjs` — black-box verifiers, deliberately independent of the vitest suites.
- `SPEC.md` — the reviewed product spec. `docs/` — spec/code review-panel records.

## Invariants — do not break

**Security (user-facing trust):**
1. Provider installs run **only** from an explicit user click, using the **fixed server-side recipes** in `providers/install.ts`. User input never reaches a command line. Nothing is bundled or downloaded implicitly (unix agy shows a `manualCommand` for the user to run themselves).
2. Never log environment-variable **values** — not in diag, errors, bundles, or transcripts. The auth instruction passthrough filters lines matching api-key values.
3. MAT never reads or writes provider credential stores. When users blame MAT for expired logins, the real cause is upstream (see Known issues).

**Determinism:** the `mock` provider stays exempt from real-provider behaviors (spawn stagger, auth alerts/`errorReason`) so tests and instruments stay fast and deterministic. The `MOCK_AUTHFAIL` instrument depends on this.

**Contracts:** `shared/` schema changes are additive-only; `server/src/version.ts` must match `server/package.json` (a test enforces it).

**UI regressions with history:** stable zustand selectors; `min-h-0` on every flex/grid ancestor of a scroll pane; BAT-style follow mode (auto-follow disarms on wheel-up, re-arms at bottom); multi-line amber `errorReason`; no datalist; no ModelEditor auto-collapse.

## Release playbook

1. Bump the version in **six files**: `package.json`, `server/package.json`, `web/package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, `server/src/version.ts`. Leave `Cargo.lock` alone — `release.yml` builds without `--locked` and updates it in CI.
2. Commit, push, watch `ci.yml` for the pushed sha until **both** platforms are green.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` → `release.yml` builds 4 platform jobs and drafts the release with artifacts.
4. Attach bilingual notes (English then 繁體中文, same structure; voice: what changed and why it matters, driven by the field evidence that motivated it): `gh release edit vX.Y.Z --notes-file <notes.md>`.
5. Verify the artifact: `gh release download vX.Y.Z --pattern '*.deb'` → `dpkg-deb -x` → run **all** `tools/evidence/` instruments with `MAT_ROOT="<extracted>/usr/lib/Multi-AI Terminal"` (path contains a space — quote it) and `MAT_EXPECT_VERSION=X.Y.Z`. All checks must pass before reporting done.
6. Definition of done: commit → CI green both platforms → tag → 4 artifacts → notes → instrument-verified → report.

Dev-box quirks: prefix `git push`/`gh` with `env -u LD_LIBRARY_PATH`; `gh run view`/API calls occasionally hit TLS handshake timeouts — retry up to 3× before believing a failure. Local browser smoke needs `CHROME_PATH=~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome npm run smoke:browser`.

## Windows/CI portability rules (each cost real debugging time)

- New tests that spawn processes or cycle worktrees need explicit timeouts (`, 30_000`) and deadline-based waits — vitest's 5 s default fails only on Windows CI.
- When injecting an `exists`/path predicate into tests, use **pure-POSIX fixture paths** and fake fs — `join()` produces backslashes on Windows while production template strings produce forward slashes; string equality silently diverges (`existsSync` tolerates mixed separators, hiding it locally).
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
