# BAT Alignment Port Plan

Standing direction (Ted, 2026-07-22): follow Better Agent Terminal (BAT, `tony1223/better-agent-terminal`) **completely** for provider-runtime handling — installation, coordination, login, and SDK usage all follow BAT's adapters and track BAT's updates — and apply the same pattern uniformly to providers BAT doesn't cover (grok, agy). This document is the port map: what BAT does (grounded at head `0e24800`, read 2026-07-22 from a full clone), how it lands in MAT's Node-only codebase, in what order, and how we keep tracking BAT afterward.

Reference clone: `/tmp/mat-refs/better-agent-terminal` (scratch; re-fetch before each phase — see §8).

## 0. Scope and ground rules

- **What "follow BAT" means here**: same catalog/installer model, same session-runtime architecture (persistent `codex app-server` controller; claude Agent SDK runtime), same runtime posture — the session runtime is *the* production path; BAT has **no automatic CLI fallback** (claude degrades to a stub reply when the SDK can't load so the UI never hangs, and BAT's CLI-driving runtimes are debug-gated explicit modes, not failovers; BAT deleted its sidecar codex-SDK path outright). MAT keeps its existing one-shot adapters as explicitly-selectable legacy transports during the transition, mirroring that gating. Same auth/account handling, same canonical-event-contract coordination. File and script names mirror BAT's where possible so future diffs against BAT stay mechanical.
- **Owner-decided supersessions** (recorded in HANDOFF the day they were decided): managed pinned-runtime installation supersedes the earlier "drive only user-discovered CLIs / bundle nothing" stance. The old invariant's spirit survives structurally: fixed pinned versions, integrity hashes verified before extraction, installs into MAT's own data directory (never host toolchains, never PATH/shell-profile edits, never elevation).
- **BAT behaviors that come with the package** (they differ from MAT's previous explicit-click-only stance; adopting them IS the directive): desktop first-run auto-install of *missing* runtimes (quiet, 5 s after launch, never touches a *broken* one), headless server self-provisioning codex in a background thread at startup, sidecar self-installing claude when a login flow needs it. Each is scoped exactly as BAT scopes it (§1.4).
- **Unchanged MAT invariants**: evidence plane (seq authority, immutable events, replay) holds across every new event mapping; never log values read from the environment; never run real provider login commands to probe output; `codex login --device-auth` semantics and CODEX_HOME hygiene rules stay; `shared/` schemas additive-only; no PTY (app-server JSON-RPC and the Agent SDK are headless machine interfaces); agent-lane lifecycle scripts (`agent:*`) still never install anything — the managed-runtime installer belongs to the MAT server proper, not the agent lane.
- **Provider credential handling** changes shape with BAT's auth model (§4); the HANDOFF boundary text gets rewritten in the same commit that implements it.

## 1. Managed runtime layer — catalog + installer (task #20)

### 1.1 BAT mechanics (what we are porting)

**Catalog** — `runtime-catalog.json` at repo root, three sections, six platform keys (`darwin|linux|win32` × `arm64|x64`, i.e. exactly Node's `${os.platform()}-${os.arch()}`):

| family | pinned by | per-platform shape | integrity |
|---|---|---|---|
| `claude` | version of installed `@anthropic-ai/claude-agent-sdk` | separate packages `@anthropic-ai/claude-agent-sdk-<key>` | sha512 SRI from npm `dist.integrity` |
| `codex` | version of installed `@openai/codex` | one package, per-platform npm *versions* `<ver>-<key>` | sha512 SRI from npm `dist.integrity` |
| `node` | `DEFAULT_VERSION` const in `scripts/fetch-node-runtime.mjs` | nodejs.org dist archives (`tar.gz`/`tar.xz`/`zip` + `exePath`) | sha256 hex from `SHASUMS256.txt` |

**Generator** — `scripts/sync-runtime-catalog.mjs`: pinned versions are read *offline* from the locally installed packages' `package.json` (direct file read — the SDK hides `package.json` behind its exports map, so no `require.resolve`); integrity is fetched fresh from `registry.npmjs.org` / `nodejs.org`. If offline and a committed catalog exists → warn and keep it. Idempotent write. A guard test (`tests/runtime-catalog-sync.test.mjs`, offline, in the pre-CI verify chain) fails the build when the committed catalog drifts from the installed dependency versions — that guard is what makes "adapter written against ONE known version" enforceable.

**Install algorithm** (BAT `src-tauri/src/runtime_install.rs` — tauri-free core — plus `commands/runtime.rs`; claude already has a complete pure-JS twin in `node-sidecar/src/handlers/claude-auth.mjs`, which is our closest porting reference):

1. Idempotence gate: if the managed binary at the pinned path already passes a 5 s `--version` probe, return early.
2. Download the archive (UA `…-runtime-installer`; timeouts: codex 120 s, node/claude 60 s).
3. Verify integrity **before touching the bytes further** — sha512 SRI (claude/codex) or sha256 hex (node); mismatch aborts.
4. Extract:
   - claude `.tgz` → gunzip + single-file ustar read of `package/claude[.exe]` (standalone native binary);
   - codex `.tgz` → gunzip + multi-file ustar walk of `package/vendor/<rust-triple>/` (whole tree: `bin/codex`, helper binaries, `codex-path/rg`, `codex-resources/`, `codex-package.json` — codex only finds its helpers when `bin/`'s parent holds `codex-package.json`), with **path-traversal guard** (reject empty/`.`/`..` segments) and per-entry exec-bit preservation (chmod `0o700` iff tar mode had any exec bit);
   - node archives → shell out to system `tar -xf` (handles gz/xz/zip; Windows: `C:\Windows\System32\tar.exe`), then copy only `exePath` (+ LICENSE, `.node-version`).
5. Stage under `runtimes/.tmp/<family>-<nonce>/`, validate the staged binary with `--version`, then **atomic swap with rollback**: rename existing final dir → `.<name>.backup-<nonce>`, rename staged → final, on failure rename backup back. Staging lives under `runtimes/` on purpose (same filesystem → no cross-device rename failures).
6. Prune every non-pinned version dir under the family root (best-effort, errors ignored for Windows file locks).
7. Desktop additionally records `runtimes/manifest.json` (`{version, source:"managed", url, installedAt}`) — bookkeeping only; resolution never reads it.

**Layout**: `<dataDir>/runtimes/<family>/<version>/<platform-key>/…`, families `node`, `codex`, `claude-agent-sdk`. Version bumps are **path-keyed, not in-place**: resolvers only ever look at the pinned version's path, so after a bump the old dir simply stops resolving (status → `missing`) and the normal install triggers lay down the new version, then prune.

### 1.2 Trigger model (port as-is)

- **Explicit**: install / replace / clear buttons in settings → server mutation endpoint, serialized by a global runtime-mutation lock, emitting a `runtime:changed`-style event on completion.
- **Desktop first-run auto-install**: 5 s after UI launch, fetch runtime status; for tools in order `node → codex → claude` (MAT: + `grok → agy`) with state `missing` **and** `canInstallManaged`, install sequentially and quietly. `broken` is deliberately never auto-touched.
- **Headless self-provision**: MAT server startup (the bat-server analog) checks the managed codex path; if missing, installs in a detached background task so a ~100 MB download never blocks serving. Failure (offline, unsupported arch) leaves the server usable for other providers. Idempotent every boot.
- **On-demand**: login flows that need a CLI may resolve-with-install (BAT's sidecar does this for claude), de-duplicated through a single in-flight install promise.

### 1.3 Resolution order (spawn time)

`env override (absolute path, e.g. MAT_CLAUDE_BIN/MAT_CODEX_BIN) → managed pinned path (absolute) → PATH-discovered → bundled/resource → bare name on PATH`. Managed resolution is strictly the pinned version's directory — stale versions never resolve. Caches invalidate when a newly managed binary appears. Codex spawns get PATH *augmented* (prepend codex's own `codex-path/` helper dir + the resolved node dir) so descendant `env node` shells work — augmentation of the child's env only, never the host's.

### 1.4 MAT port design

- Files: `runtime-catalog.json` (repo root, committed), `scripts/sync-runtime-catalog.mjs`, guard test wired into `npm test`; server modules `server/src/runtime/catalog.ts`, `install.ts` (download/verify/extract/swap/prune), `resolve.ts` (per-family resolution), `triggers.ts` (explicit endpoint + boot self-provision + first-run hook for the web UI).
- Add `@anthropic-ai/claude-agent-sdk` and `@openai/codex` to MAT's dependencies **at BAT's pinned versions** (today: SDK 0.3.212, codex 0.144.5); the sync script reads them locally, exactly like BAT. When BAT bumps, we bump to match (§8).
- Managed-node section: keep it in the catalog for shape parity with BAT, but MAT's server already runs under a user-provided Node ≥ 20 (source lane) or the desktop bundle — actually *installing* managed node is deferred until something needs it; the resolver treats it as optional.
- grok/agy get catalog sections in the same shape (§5): pinned version + tarball integrity; if a provider ships a single platform-independent npm package, the section has one entry instead of six — same verify/extract/swap path.
- Extraction: port BAT's hand-rolled ustar parsers (single-file + multi-file-with-modes-and-traversal-guard) rather than adding a tar dependency — they're small, auditable, and byte-compatible with what BAT extracts. System `tar -xf` spawn only for the node family (matching BAT). Reviewed decision (2026-07-22 three-way): no extra tar hardening flags — BAT itself shells bare `tar -xf`, `--one-top-level` isn't portable across bsdtar/GNU/Windows tar, and the trust anchor is the pinned sha256; revisit only if node archives ever come from a less-pinned source.
- MAT's existing explicit-click provider install recipes are *re-implemented on top of* the managed installer (the click now produces a pinned, hash-verified install into `<dataDir>/runtimes/` instead of the old recipe).
- Tests: unit (SRI/sha256 verify, tar parser traversal rejection, exec-bit rule, swap rollback on injected rename failure, prune) + an integration install against a local fixture tarball served from disk — no network in CI.

## 2. Codex session runtime — persistent `codex app-server` controller (task #21)

### 2.1 Where it lives in BAT

The live controller is 100% Rust: `src-tauri/src/codex_app_server.rs` (~7,900 lines, fully synchronous, driven via `spawn_blocking`). The node-sidecar's `codex.mjs` is a disabled legacy path (`createCodexInstance()` throws) — but it remains the canonical *event-mapping* reference (§5). Routing: codex sessions ride the same client-facing command surface as claude; the bridge hands a session to the codex controller when its agent preset is `codex-agent`/`codex-agent-worktree` (at start) or when the controller already owns the session id. MAT mirrors this: one command surface, per-provider ownership predicates.

### 2.2 Process model

- **ONE shared `codex app-server` child for ALL sessions/threads** (single connection slot + sessions map + thread→session map). Spawn: resolved binary (§1.3 order, `BAT_CODEX_BIN`-style env override first) with args `["app-server"]`, stdio pipe/pipe/inherit, cwd = home dir; env: `CODEX_HOME` (always), `OPENAI_API_KEY` (only if configured — and NEVER for login children), PATH augmented per §1.3.
- **Lazy, no supervisor**: the connection spawns on first need; on stdout EOF the reader drains every pending request with an error, cancels now-dead approvals, and clears the slot — the *next* request respawns fresh. Teardown is an explicit kill.
- Connection deliberately recycled when: the idle reaper fires (30 s check interval; ≥300 s idle AND no running session AND no login in flight AND no pending approval), the auth identity changed, or the resolved binary changed while nothing runs (deferred if a turn is in flight).
- Timeouts: request 30 s; turn/start 60 s; interrupt wait 30 s; rate-limit read 15 s; login 300 s; command-output deltas throttled to 100 ms.

### 2.3 Wire protocol (JSON-RPC over JSONL)

One JSON object per line on stdin/stdout. Client requests `{method, id, params}` with a monotonic id starting at 1; notifications omit `id`; replies to *server-initiated* requests echo the server's id with `{result}` or `{error:{code,message}}`. Pending-request table keyed by id. Inbound dispatch: `method`+`id` → server request; `method` only → notification; `id` only → response.

Handshake (response body ignored, success-checked only):

```
→ {"method":"initialize","id":1,"params":{"clientInfo":{"name":…,"title":…,"version":…},"capabilities":{"experimentalApi":true}}}
→ {"method":"initialized","params":{}}
```

Client→server methods: `thread/start` `{model, cwd, approvalPolicy, sandbox, serviceName}` → `thread.id`; `thread/resume` `{threadId, …same}`; `turn/start` `{threadId, input[], model, effort, summary:"auto", approvalPolicy, sandboxPolicy:{type}}` → `turn.id`; `turn/interrupt` `{threadId, turnId}`; `account/rateLimits/read`; `account/login/start` `{"type":"chatgptDeviceCode"}` / `account/login/cancel`.

Parameter notes: thread-level `sandbox` is the plain string `read-only|workspace-write|danger-full-access` while turn-level `sandboxPolicy` is the tagged object `{type:"readOnly"|"workspaceWrite"|"dangerFullAccess"}`; `approvalPolicy` normalizes to `untrusted|on-request|never`; effort ∈ `minimal…xhigh|max|ultra`; `input` items are `{type:"text", text, text_elements:[]}`, `{type:"localImage", path}` (data-URLs land in temp files first), `{type:"image", url}`. The per-turn policy is authoritative for subsequent turns — settings changes apply without re-resume.

Server→client **requests** (must be answered or the turn blocks): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`; anything else gets a `-32601` error reply.

Notifications consumed: `thread/started`; `turn/started`; `turn/completed` (`turn.status` completed|interrupted|failed → reason completed|aborted|error, plus per-turn `turn.usage`); `item/started` / `item/completed`; `item/agentMessage/delta` (text), `item/reasoning/summaryTextDelta`+`textDelta` (thinking), `item/commandExecution/outputDelta` (ANSI-stripped, accumulated per item); `thread/tokenUsage/updated` (aliased field names; `total` = cumulative, `last` = live context footprint; `modelContextWindow`); `error` `{message, willRetry}` — retryable keeps the turn alive with runtimeStatus `reconnecting`, fatal fails it; `account/login/completed`; `account/rateLimits/updated`. Notification→session mapping goes through threadId (fallback: the sole session; else drop).

### 2.4 Thread & turn lifecycle

- `thread/start` on first send; `thread/resume` for known threads; if `turn/start` reports thread-not-found, resume lazily and retry. Codex persists rollout JSONLs under `$CODEX_HOME/sessions/**` — a thread that never completed a first turn has **no rollout**, so a thread whose process was reaped pre-first-turn is *replaced* with a fresh `thread/start` rather than resumed.
- Per-session async serialization for send/abort/stop/reset (one session's operations queue; other sessions unaffected); notification handling never takes that lock.
- **Interrupt state machine** (the trickiest part — port faithfully): abort cancels pending approvals first; if `turn/start` returned but `turn/started` hasn't arrived, wait (≤30 s) for the live turn id; interrupt retries on "…but found <turnId>" using the reported id, and on "no active turn" consults local turn state (pending → wait; started → short retries; finished → done). If abort lands before `turn/started`, a flag makes that handler fire the interrupt late. Interrupted turn ids go into a small remembered ring so their late events are filtered as stale instead of corrupting the next turn.
- A new message while a turn runs = interrupt-then-start (replace semantics).
- Approval round-trip: server request → synthetic toolUseId `codex-approval-<requestId>`, toolName `Bash` (command, cwd) or `Edit` (file change), decision reason from `reason`/network host → `claude:permission-request`; the client's answer maps allow → `"accept"` (or `"acceptForSession"` with don't-ask-again), deny → `"decline"`; turn end/abort/dead connection auto-answers `"cancel"`.

### 2.5 MAT port design

- Modules: `server/src/providers/codex/connection.ts` (spawn + JSONL codec + pending table + reaper), `threads.ts` (session↔thread ownership, turn lifecycle, interrupt state machine, stale filtering), `translate.ts` (item/turn → contract events; mapping reference = BAT's codex.mjs plus the Rust emit sites), `models.ts` (authoritative list from BAT — default `gpt-5.6-sol`; efforts `minimal…ultra`; context-window fallbacks).
- MAT's server is one long-lived process, so the single-shared-connection model maps 1:1. Node's single thread removes most locking; what must survive: the per-session async operation queue, the pending-approval registry, and auth-swap serialization.
- Tests: a scripted fake app-server (a Node script speaking the JSONL protocol, injected via `MAT_CODEX_BIN`) exercising handshake, streamed turns, approvals, the interrupt dance, `willRetry` errors, EOF-drain + respawn, and the reaper predicate; plus translation-table unit tests.

## 3. Claude session runtime + canonical event contract (task #22)

### 3.1 Architecture facts (corrected from first assumptions)

- BAT's production Agent SDK runtime is **`node-sidecar/src/handlers/claude-send.mjs` (~1,120 lines) + `lib/live-query.mjs` + `lib/sdk-loader.mjs`** against `@anthropic-ai/claude-agent-sdk@0.3.212`. The `claude-channel-runtime.mjs` / `claude-cli-runtime.mjs` files are `BAT_DEBUG`-gated experiments with their own RPC methods and separate `claude-channel:*` / `claude-cli:*` event namespaces — *not* the SDK runtime and *not* fallbacks.
- No SDK→CLI failover exists: if `loadAnthropicSdk()` yields null, the send path emits a stub assistant message plus `turn-end{completed}` so the client never hangs.
- The sidecar wire is line-delimited JSON-RPC 2.0 over stdio; server→client events are `event:<name>` notifications; handlers register in a method map (`claude.*` ≈ 55 methods covering session lifecycle, send, permissions, auth, accounts, models, skills).

### 3.2 SDK usage mechanics to port

- **Lazy loader**: import once, cache module-or-null, `BAT_SIDECAR_DISABLE_SDK=1` escape hatch + a test-only override setter (MAT names: `MAT_DISABLE_AGENT_SDK`, plus `MAT_CLAUDE_BIN`/`MAT_CODEX_BIN` for binary overrides).
- **Streaming-input LiveQuery** — the core pattern: ONE persistent `sdk.query({prompt, options})` per session where `prompt` is an `AsyncIterable` fed by a queue+waker, keeping the CLI subprocess warm across turns. `push(userMessage)` returns a promise resolved on the next `result` frame (FIFO deferreds); a background drain loop dispatches every SDK message to the translator. Generator throw/close rejects pending pushes; some SDK builds close the generator after each result even in streaming mode, so the next send rebuilds the query with `resume: sdkSessionId`.
- **`queryOptions` essentials**: `cwd`; `systemPrompt`/`tools` `{type:'preset', preset:'claude_code'}`; `includePartialMessages: true`; `permissionMode` (with `bypassPermissions` requiring `allowDangerouslySkipPermissions: true`); `effort`; `model` (preset suffixes like `:auto-compact-<N>k` stripped to the base id, window passed via `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env); `pathToClaudeCodeExecutable` from resolve-with-install (§1.3); `stderr` callback keeping a rolling 8 KB tail for error enrichment; `canUseTool` permission hook; `resume`/`continue`; `abortController`.
- **Control surface**: `.interrupt()` = soft stop (subprocess and LiveQuery survive; the in-flight turn's result becomes `turn-end{reason:'interrupted'}`); `abortController.abort()` + close = hard stop (`turn-end{reason:'aborted'}`); `.setModel()` / `.setPermissionMode()` applied live when possible, else close-and-rebuild on next send; `.stopTask(taskId)` for background tasks.
- **Translation table** (SDK message → contract events): `system/init` → capture `sdkSessionId`/model + `claude:status`; `stream_event` text/thinking deltas → `claude:stream`; `assistant` → `claude:message` (thinking+text flattened) + one `claude:tool-use` per `tool_use` block; `user` `tool_result` blocks → `claude:tool-result`; `result` → `claude:result` + **exactly one** `claude:turn-end` (`completed`/`error`/`interrupted`); `rate_limit_event` → `claude:rate-limit`; task lifecycle messages → `claude:task`.
- **Permission round-trip**: `canUseTool` returns an immediate `{behavior:'allow'|'deny', updatedInput}` or a promise the client resolves (`claude:permission-request` → `resolvePermission`; the `AskUserQuestion` pseudo-tool → `claude:ask-user` → `resolveAskUser`, answers merged into `updatedInput`). Mode-specific auto-allow: `acceptEdits` auto-allows {Write, Edit, NotebookEdit, Read, Glob, Grep}; `bypassPermissions` allows all; plan modes gate `ExitPlanMode`. Pending resolvers keyed by toolUseId; resolutions re-broadcast idempotently.
- **Resume durability**: BAT deliberately excludes `sdkSessionId` from persisted session config — the *client's* disk store owns durable resume and replays it. In MAT the server-side evidence store plays that durable-owner role (MAT's client is a thin web UI); the wire semantics stay BAT's, only the storage authority sits server-side.

### 3.3 The canonical event contract — what every provider emits

19 `claude:*` events, all payloads carrying `sessionId`. This name set is provider-neutral in BAT (codex emits the same names); MAT adopts it as the internal provider-manager surface:

| event | payload essence |
|---|---|
| `claude:message` | `{id, role, content, thinking?, parentToolUseId?, timestamp}` |
| `claude:tool-use` | `{id, toolName, input, status:'running', parentToolUseId}` |
| `claude:tool-result` | `{id (=tool_use_id), status:'completed'\|'error', result}` |
| `claude:stream` | `{text?, thinking?, parentToolUseId}` |
| `claude:status` | full session meta — **always full-shape** (~19 fields: mode, model, effort, tokens, cost, context, streaming flags, runtimeStatus…) |
| `claude:result` | raw SDK result message (usage, cost, num_turns, stop_reason) |
| `claude:turn-end` | `{reason:'completed'\|'error'\|'interrupted'\|'aborted', …}` — **exactly one per turn** |
| `claude:error` | `{error: string}` |
| `claude:rate-limit` | `{rateLimitType, resetsAt(ms), utilization, isUsingOverage}` |
| `claude:task` | subagent/workflow task lifecycle `{id, toolUseId, type, status, …}` |
| `claude:permission-request` / `claude:permission-resolved` | `{toolUseId, toolName, input, suggestions…}` / `{toolUseId}` |
| `claude:ask-user` / `claude:ask-user-resolved` | `{toolUseId, questions}` / `{toolUseId}` |
| `claude:modeChange` | `{mode}` |
| `claude:history` | replayed items for resume |
| `claude:resume-loading` | `{loading: boolean}` |
| `claude:session-reset` | `{}` |
| `claude:worktree-info` | worktree metadata or null |

Two hard rules BAT's client depends on (MAT's evidence plane will assert them): every turn terminates with exactly one `turn-end`, and `status` meta is never partial.

### 3.4 MAT port design

- Modules: `server/src/providers/contract.ts` (the event surface as a `shared/` schema addition — additive-only), `server/src/providers/claude/sdk-loader.ts`, `server/src/providers/claude/live-query.ts`, `server/src/providers/claude/sdk-runtime.ts` (options builder + translation table + permission hook); the existing one-shot CLI adapter remains an explicitly-selectable legacy mode.
- Session registry mirrors BAT's `state.mjs`: sessions Map + config Map surviving delete + a `buildSessionMeta` that always emits full shape.
- Evidence: one mapper from contract events into MAT evidence events, preserving seq authority/immutability/replay; assertions for the two hard rules above.
- Tests: fake-SDK override driving the full translation table, permission/ask-user round-trips, interrupt-vs-abort semantics, rebuild-with-resume, stub path when SDK unavailable.
- Known risk carried from #20: the SDK declares a `zod@4` peer while MAT is `zod@3`; the repo pins `legacy-peer-deps=true` so the peer is not auto-installed. Before the first runtime import of the SDK, add a loader smoke test proving module load + a minimal call under the repo's real dependency tree; if the SDK genuinely needs its own zod@4, give *it* a nested copy — never upgrade MAT's zod out from under `shared/`.

## 4. Auth and account alignment (task #23)

### 4.1 claude — delegate everything to the CLI (grounded)

BAT **never parses or writes `~/.claude` credentials**; the claude CLI owns its store, and the same binary is what the SDK drives via `pathToClaudeCodeExecutable`:

- Status: shell `claude auth status` (10 s timeout), JSON-parse stdout, null on any failure — "logged in" detection is exactly "status parses".
- Desktop login: shell `claude auth login` (browser OAuth), wait for exit with a 180 s ceiling, resolve-with-install so a missing managed binary gets installed first.
- Headless three-step login: spawn `claude auth login` with `TERM=dumb`; scrape the OAuth URL from output and **validate its host against a trusted allow-list** (claude.ai / claude.com / anthropic.com) before returning `{url, loginId}`; submit the pasted code via the child's stdin (success = exit 0 without failure markers); cancel kills only the matching in-flight login; error text is redacted (codes and URLs stripped). One login in flight at a time — credentials are host-global.
- Account index: a sanitized read-only JSON index (id/email/subscription only); encrypted credential files are never touched.

This model is *compatible* with MAT's existing "never reads/writes provider credential stores" invariant — MAT, like BAT, only shells the CLI's own auth subcommands. MAT's existing in-app sign-in flows get audited against this shape and aligned.

### 4.2 codex — CODEX_HOME is the auth surface; keys are optional (grounded)

- **OAuth (ChatGPT) is primary and involves no key material in BAT's hands**: codex itself reads `$CODEX_HOME/auth.json`; BAT only decides *which* CODEX_HOME the app-server process gets. Auth-failure substrings in error notifications ("please log in again", "token_invalidated", "401 unauthorized", …) mark the active account needs-login.
- **`OPENAI_API_KEY` env is optional**, resolved keyring-first: (1) native keyring (service `better-agent-terminal:openai-api-key`, account `default`), (2) `<dataDir>/openai-api-key.bin` (0600), (3) the `OPENAI_API_KEY` env var. This chain feeds only the spawned child's env — and login children are spawned *without* it so OAuth login never sees a key. This is the **one place BAT itself stores a provider credential**.
- **Unified account store**: index `<dataDir>/codex-accounts.json` + per-account `<dataDir>/codex-accounts/<id>/auth.json`. The shared CODEX_HOME's `auth.json` is the live identity; **switching accounts copies exactly one file** (store copy → shared `auth.json`) and drops the app-server connection so the next spawn runs as the new identity; capture-current snapshots the live file back into the store; an exit hook re-snapshots. Switch/capture/remove refuse while a login or turn is in flight. There is no logout verb — remove or switch.
- Login flows: browser/`--api-key` login via a spawned `codex login` child (300 s, cancellable), or in-protocol device-code (`account/login/start {type:"chatgptDeviceCode"}` → `{url, code}`, completion via the `account/login/completed` notification, cancel via `account/login/cancel`).
- MAT adoption: same shared-home + copy-only-`auth.json` store under MAT's data dir; keyring is desktop-optional (headless baseline = file + env, matching BAT's own fallbacks); credential writes only from explicit user action; never logged. Note the visible tension with the standing dev rule "never copy auth.json between CODEX_HOMEs": that rule stays for *development/debugging by hand*; BAT's store mechanism is the product's own account-switch feature, precisely scoped to the one file, and comes with the package Ted chose. The HANDOFF credential-boundary text is rewritten in the commit that implements this.

Standing development rules unchanged: never run real provider login commands to probe output; `codex login --device-auth` discards the default-store login the moment it starts; never log values read from the environment.

## 5. Grok / agy / OpenRouter — same contract, two transport routes (task #24)

BAT has no grok/agy; the directive is uniformity — and the template already exists: **`node-sidecar/src/handlers/codex.mjs` (~850 lines) is BAT's canonical "second provider behind the same contract" module.** Each MAT provider manager copies its shape:

- own sessions Map plus `is<Provider>Session`/`is<Provider>AgentPreset` predicates; the shared router dispatches lifecycle and send calls to the provider module;
- a metadata builder emitting the SAME full-shape `claude:status` meta;
- an adapter translating the provider's native stream into the 19 events — codex maps `thread.started` / `item.started|updated|completed` / `turn.completed` into tool-use/tool-result/stream/message/status/result/turn-end, and maps its tool types onto Claude tool names (`command_execution`→Bash, `file_change`→Edit, `web_search`→WebSearch, `todo_list`→TodoWrite) so one UI renders every provider.

Two integration models, chosen per provider: **(1) session backend** (claude Agent SDK, codex app-server) — wrap in LiveQuery when the backend accepts a streaming prompt and yields a terminal result frame; **(2) CLI observation** (BAT's debug runtimes are the reference: spawn the CLI, wire hooks to a loopback bridge, tail transcripts, normalize frames). grok/agy start as model-(2)-style managers over their existing streaming-JSON adapters and swap transports without contract change if they ever grow a session interface.

Cross-cutting mechanics ported once into the shared manager layer: FIFO send queue with a cancel token (Esc cancels queued-but-not-live turns), `clientMessageId` idempotency records (retry-safe sends), runtimeStatus lifecycle (`starting` → `waiting_for_api` → cleared on first frame) for the "thinking" indicator, effort mapping with rejection-driven downgrade, model presets with suffix stripping.

**Route B — codex-as-runtime for OpenAI-compatible providers (Ted, 2026-07-22: OpenRouter becomes provider #5).** The open-source codex CLI supports custom model providers over OpenAI-compatible APIs, and BAT already exercises this end-to-end: Fugu models run through the *same* app-server with `modelProvider:"sakana"` in `thread/start` and `SAKANA_API_KEY` injected at spawn. That makes the §2 controller a universal agent runtime — codex's sandbox, tools, approvals, and rollouts, our one event contract:

- **grok**: xAI's API is OpenAI-compatible → grok models can run inside codex's agent loop with `XAI_API_KEY`. The existing grok CLI adapter stays the *default* transport (subscription billing); the codex-runtime route is the opt-in upgrade that buys real session semantics at API-metered prices.
- **OpenRouter (provider #5)**: an OpenAI-compatible aggregator with no agent runtime of its own — Route B is the only route, and it opens every model OpenRouter carries at once. Tool-calling quality varies per model; that's the user's model choice, surfaced honestly in the UI.
- **agy**: decided by what it exposes — OpenAI-compatible API → Route B; own CLI only → Route A manager wrap (current adapter), transport swapped later if it ships a machine interface. Spiking this is #24 step 1.

Containment: Route B sessions run the same managed codex binary under a **MAT-owned, config-only CODEX_HOME** (`model_providers` entries only; API keys injected as child env at spawn, never written to disk by MAT) so the user's own `~/.codex` config and auth are untouched, and ChatGPT-account features (login flows, rateLimits) are simply absent there. Spike before building (#24 step 1): confirm the custom-provider mechanism on the pinned codex version — config.toml `model_providers` + `wire_api:"chat"` vs the `modelProvider` thread param — against the managed 0.144.x binary.

## 6. Evidence-plane mapping (task #25, continuous)

Every session-runtime event stream maps into MAT's evidence plane under the existing invariants: server-side seq is the only authority, events are immutable once written, replay must reproduce. The new runtimes emit richer streams (deltas, tool events, approvals, token usage) — the mapping tables live in §2/§3 and get evidence tests alongside each runtime.

## 7. Phasing (tasks #19–#25)

1. **#19** this document (port map complete = §2–§4 filled).
2. **#20** catalog + managed installer — first, because #21/#22 are written against pinned versions.
3. **#21** codex app-server controller (legacy exec adapter stays as an explicit mode).
4. **#22** claude Agent SDK runtime (legacy CLI adapter stays as an explicit mode).
5. **#23** auth/account alignment (paired with whichever of #21/#22 it unblocks first).
6. **#24** grok/agy managers + OpenRouter as provider #5 via the codex-runtime route (§5 Route B, spike first).
7. **#25** evidence + tests + release per the release playbook — shipped per phase, not one big bang; each phase releases the day it's green.

## 8. Tracking BAT updates (跟著他的更新走)

Before starting any phase (and periodically after):

1. `git -C /tmp/mat-refs/better-agent-terminal fetch && git -C … pull --ff-only` (re-clone if the scratch dir is gone).
2. Diff since the recorded head: `runtime-catalog.json`, `scripts/sync-runtime-catalog.mjs`, `src-tauri/src/{runtime_install,runtime_catalog,codex_app_server,codex_auth,codex_account_store}.rs`, `node-sidecar/src/{handlers,runtimes,lib}/`.
3. If BAT bumped pinned runtime versions: bump MAT's matching dependencies, run `npm run sync:runtime-catalog`, let the guard test prove the catalog matches.
4. If BAT changed adapter behavior: port the change, note the new head SHA below.

| date | BAT head | note |
|---|---|---|
| 2026-07-22 | `0e24800` | baseline for this plan |
