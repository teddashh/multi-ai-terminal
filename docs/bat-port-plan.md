# BAT Alignment Port Plan

Standing direction (Ted, 2026-07-22): follow Better Agent Terminal (BAT, `tony1223/better-agent-terminal`) **completely** for provider-runtime handling — installation, coordination, login, and SDK usage all follow BAT's adapters and track BAT's updates — and apply the same pattern uniformly to providers BAT doesn't cover (grok, agy). This document is the port map: what BAT does (grounded at head `0e24800`, read 2026-07-22 from a full clone), how it lands in MAT's Node-only codebase, in what order, and how we keep tracking BAT afterward.

Reference clone: `/tmp/mat-refs/better-agent-terminal` (scratch; re-fetch before each phase — see §8).

Status at the 2026-07-23 documentation update: BAT was rechecked and its relevant head remains `0e24800`; #20–#25 are released through MAT v0.2.10.

## 0. Scope and ground rules

- **What "follow BAT" means here**: same catalog/installer model, same session-runtime architecture (persistent `codex app-server` controller; claude Agent SDK runtime), same runtime posture — the session runtime is *the* production path; BAT has **no automatic CLI fallback** (claude degrades to a stub reply when the SDK can't load so the UI never hangs, and BAT's CLI-driving runtimes are debug-gated explicit modes, not failovers; BAT deleted its sidecar codex-SDK path outright). MAT keeps its existing one-shot adapters as explicitly-selectable legacy transports during the transition, mirroring that gating. Same auth/account handling, same canonical-event-contract coordination. File and script names mirror BAT's where possible so future diffs against BAT stay mechanical.
- **Owner-decided supersessions** (recorded in HANDOFF the day they were decided): managed pinned-runtime installation supersedes the earlier "drive only user-discovered CLIs" stance. Fixed versions and integrity hashes are installed into MAT's own data directory (never host toolchains, never PATH/shell-profile edits, never elevation).
- **Smooth first-run trigger model**: follow BAT's quiet startup self-provision pattern for missing supported managed runtimes. The desktop's single server coordinator rechecks and bootstraps Codex then Claude through MAT's pinned, integrity-verified installer; the web client does not race it with duplicate mutations. Setup remains the visible recovery path. Provider-specific recipes and sign-in stay fixed product actions with no user-supplied command line.
- **Unchanged MAT invariants**: evidence plane (seq authority, immutable events, replay) holds across every new event mapping; never log values read from the environment; never run real provider login commands to probe output; `codex login --device-auth` semantics and CODEX_HOME hygiene rules stay; `shared/` schemas additive-only; no PTY (app-server JSON-RPC and the Agent SDK are headless machine interfaces); agent-lane lifecycle scripts (`agent:*`) still never install anything — the managed-runtime installer belongs to the MAT server proper, not the agent lane.
- **Provider credential handling** follows the implemented v0.2.9 boundary in §4 and `HANDOFF.md`.

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

### 1.2 Trigger model

- **Bootstrap / install / replace / clear**: desktop startup may call the fixed server mutation endpoint for a missing supported managed runtime; Setup exposes the same recovery path. Mutations are serialized by the global runtime-mutation lock and followed by runtime/provider status rechecks.
- **Scoped automation**: the desktop enables startup bootstrap; ordinary headless/source-lane launches do not. Provider execution and sign-in never invent arbitrary downloads or commands.
- **No command injection**: the endpoint accepts a runtime family/provider id only; catalog URL, version, integrity, extraction layout, and command arguments are server-owned constants.

### 1.3 Resolution order (spawn time)

`env override (absolute path, e.g. MAT_CLAUDE_BIN/MAT_CODEX_BIN) → managed pinned path (absolute) → PATH-discovered → bundled/resource → bare name on PATH`. Managed resolution is strictly the pinned version's directory — stale versions never resolve. Caches invalidate when a newly managed binary appears. Codex spawns get PATH *augmented* (prepend codex's own `codex-path/` helper dir + the resolved node dir) so descendant `env node` shells work — augmentation of the child's env only, never the host's.

### 1.4 MAT port design

- Files: `runtime-catalog.json` (repo root, committed), `scripts/sync-runtime-catalog.mjs`, guard test wired into `npm test`; server modules `server/src/runtime/catalog.ts`, `install.ts` (download/verify/extract/swap/prune), `resolve.ts` (per-family resolution), and `triggers.ts` (startup bootstrap plus serialized mutation/status events).
- Add `@anthropic-ai/claude-agent-sdk` and `@openai/codex` to MAT's dependencies **at BAT's pinned versions** (today: SDK 0.3.212, codex 0.144.5); the sync script reads them locally, exactly like BAT. When BAT bumps, we bump to match (§8).
- Managed-node section: keep it in the catalog for shape parity with BAT, but MAT's server already runs under a user-provided Node ≥ 20 (source lane) or the desktop bundle — actually *installing* managed node is deferred until something needs it; the resolver treats it as optional.
- The released managed families remain claude/codex (with node retained in the catalog shape). Grok/Agy use their existing resolved CLI transports behind managers in #24; adding a managed family requires a separately grounded catalog entry and is not implied.
- Extraction: port BAT's hand-rolled ustar parsers (single-file + multi-file-with-modes-and-traversal-guard) rather than adding a tar dependency — they're small, auditable, and byte-compatible with what BAT extracts. System `tar -xf` spawn only for the node family (matching BAT). Reviewed decision (2026-07-22 three-way): no extra tar hardening flags — BAT itself shells bare `tar -xf`, `--one-top-level` isn't portable across bsdtar/GNU/Windows tar, and the trust anchor is the pinned sha256; revisit only if node archives ever come from a less-pinned source.
- Startup bootstrap and runtime-backed provider Setup actions use the same managed installer: both produce a pinned, hash-verified install under `<dataDir>/runtimes/`, never an `@latest` host-global install. Providers without a managed artifact remain behind their fixed, no-user-input recipe/manual-command boundary.
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

- Modules: `server/src/providers/codex/connection.ts` (spawn + JSONL codec + pending table + reaper), `threads.ts` (session↔thread ownership, turn lifecycle, interrupt state machine, stale filtering), `translate.ts` (native item/turn → content events; the shared contract bridge supplies manager status/terminal projection), and `models.ts` (authoritative list from BAT — default `gpt-5.6-sol`; efforts `minimal…ultra`; context-window fallbacks).
- MAT's server is one long-lived process, so the single-shared-connection model maps 1:1. Node's single thread removes most locking; what must survive: the per-session async operation queue, the pending-approval registry, and auth-swap serialization.
- Tests: a scripted fake app-server (a Node script speaking the JSONL protocol, injected via `MAT_CODEX_BIN`) exercising handshake, streamed turns, approvals, the interrupt dance, `willRetry` errors, EOF-drain + respawn, and the reaper predicate; plus translation-table unit tests.

## 3. Claude session runtime + canonical event contract (task #22)

### 3.1 Architecture facts (corrected from first assumptions)

- BAT's production Agent SDK runtime is **`node-sidecar/src/handlers/claude-send.mjs` (~1,120 lines) + `lib/live-query.mjs` + `lib/sdk-loader.mjs`** against `@anthropic-ai/claude-agent-sdk@0.3.212`. The `claude-channel-runtime.mjs` / `claude-cli-runtime.mjs` files are `BAT_DEBUG`-gated experiments with their own RPC methods and separate `claude-channel:*` / `claude-cli:*` event namespaces — *not* the SDK runtime and *not* fallbacks.
- No SDK→CLI failover exists: if `loadAnthropicSdk()` yields null, the send path emits a stub assistant message plus `turn-end{completed}` so the client never hangs.
- The sidecar wire is line-delimited JSON-RPC 2.0 over stdio; server→client events are `event:<name>` notifications; handlers register in a method map (`claude.*` ≈ 55 methods covering session lifecycle, send, permissions, auth, accounts, models, skills).

### 3.2 BAT reference mechanics and MAT's ported subset

This subsection records BAT's architecture reference. It is not a claim that every control surface below is reachable in MAT today: MAT currently uses immediate `canUseTool` allow/deny decisions, while interactive permission and `AskUserQuestion` round-trips remain deferred.

- **Lazy loader**: import once, cache module-or-null, `BAT_SIDECAR_DISABLE_SDK=1` escape hatch + a test-only override setter (MAT names: `MAT_DISABLE_AGENT_SDK`, plus `MAT_CLAUDE_BIN`/`MAT_CODEX_BIN` for binary overrides).
- **Streaming-input LiveQuery** — the core pattern: ONE persistent `sdk.query({prompt, options})` per session where `prompt` is an `AsyncIterable` fed by a queue+waker, keeping the CLI subprocess warm across turns. `push(userMessage)` returns a promise resolved on the next `result` frame (FIFO deferreds); a background drain loop dispatches every SDK message to the translator. Generator throw/close rejects pending pushes; some SDK builds close the generator after each result even in streaming mode, so the next send rebuilds the query with `resume: sdkSessionId`.
- **`queryOptions` essentials**: `cwd`; `systemPrompt`/`tools` `{type:'preset', preset:'claude_code'}`; `includePartialMessages: true`; `permissionMode` (with `bypassPermissions` requiring `allowDangerouslySkipPermissions: true`); `effort`; `model` (preset suffixes like `:auto-compact-<N>k` stripped to the base id, window passed via `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env); `pathToClaudeCodeExecutable` from the resolved runtime (§1.3 — send/sign-in never installs it); `stderr` callback keeping a rolling 8 KB tail for error enrichment; `canUseTool` permission hook; `resume`/`continue`; `abortController`.
- **Control surface**: `.interrupt()` = soft stop (subprocess and LiveQuery survive; the in-flight turn's result becomes `turn-end{reason:'interrupted'}`); `abortController.abort()` + close = hard stop (`turn-end{reason:'aborted'}`); `.setModel()` / `.setPermissionMode()` applied live when possible, else close-and-rebuild on next send; `.stopTask(taskId)` for background tasks.
- **Translation table** (SDK message → contract events): `system/init` → capture `sdkSessionId`/model + `claude:status`; `stream_event` text/thinking deltas → `claude:stream`; `assistant` → `claude:message` (thinking+text flattened) + one `claude:tool-use` per `tool_use` block; `user` `tool_result` blocks → `claude:tool-result`; `result` → `claude:result` + **exactly one** `claude:turn-end` (`completed`/`error`/`interrupted`); `rate_limit_event` → `claude:rate-limit`; task lifecycle messages → `claude:task`.
- **Permission round-trip**: `canUseTool` returns an immediate `{behavior:'allow'|'deny', updatedInput}` or a promise the client resolves (`claude:permission-request` → `resolvePermission`; the `AskUserQuestion` pseudo-tool → `claude:ask-user` → `resolveAskUser`, answers merged into `updatedInput`). Mode-specific auto-allow: `acceptEdits` auto-allows {Write, Edit, NotebookEdit, Read, Glob, Grep}; `bypassPermissions` allows all; plan modes gate `ExitPlanMode`. Pending resolvers keyed by toolUseId; resolutions re-broadcast idempotently.
- **Resume durability**: BAT deliberately excludes `sdkSessionId` from persisted session config — the *client's* disk store owns durable resume and replays it. In MAT the server-side evidence store plays that durable-owner role (MAT's client is a thin web UI); the wire semantics stay BAT's, only the storage authority sits server-side.

### 3.3 BAT event vocabulary and compatibility ingress

19 `claude:*` events, all payloads carrying `sessionId`. This name set is provider-neutral in BAT (codex emits the same names); MAT adopts it as a strict, schema-validated provider-manager compatibility surface:

| event | payload essence |
|---|---|
| `claude:message` | `{id, role, content, thinking?, parentToolUseId?, timestamp}` |
| `claude:tool-use` | `{id, toolName, input, status:'running', parentToolUseId}` |
| `claude:tool-result` | `{id (=tool_use_id), status:'completed'\|'error', result}` |
| `claude:stream` | `{text?, thinking?, parentToolUseId}` |
| `claude:status` | full session meta — **always full-shape** (mode, model, effort, tokens, cost, context, streaming flags, runtimeStatus…) |
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

Current MAT production managers still enter the bridge through the content-only adapter path (`AdapterContentEvent` → `acceptContent()`), which synthesizes the reachable core message/tool/status/result/error/turn-end projection. The remaining rich shapes above are compatibility ingress reserved for native manager emitters; defining and validating them does not make permission, task, history, rate-limit, mode, reset, or worktree features reachable today.

Two hard rules BAT's client depends on (MAT's evidence plane asserts them for every started turn): every turn terminates with exactly one `turn-end`, and `status` meta is never partial.

### 3.4 MAT port design

- Modules: `shared/src/providerEvents.ts` (strict additive 19-event schemas), `server/src/providers/contract.ts` (one evidence bridge), and `server/src/providers/claude/{sdk-loader,live-query,runtime}.ts`; the existing one-shot CLI adapter remains an explicitly selectable legacy mode.
- MAT runtimes own their session maps; `ProviderTurnBridge` and `buildProviderSessionMeta` supply full-shape status snapshots. No separate persisted config-map contract is claimed.
- Evidence: `ProviderTurnBridge` is the one mapper from manager events into adapter content/technical evidence. `nodeRunner` remains the sole lifecycle writer, and `eventLog` remains the only `id/seq/ts` authority. Provider result/error/turn-end frames enrich the existing node outcome/result rather than appending a second terminal lifecycle.
- Tests: fake-SDK override drives translation, interrupt-vs-abort semantics, rebuild-with-resume, and the explicit unavailable-SDK result.
- The SDK's declared `zod@4` peer risk is closed by loader/runtime tests under MAT's real dependency tree and `legacy-peer-deps=true`; MAT's shared zod remains v3 and must not be upgraded underneath existing schemas.

## 4. Auth and account alignment (task #23)

### 4.1 claude — delegate everything to the CLI (grounded)

BAT **never parses or writes `~/.claude` credentials**; the claude CLI owns its store, and the same binary is what the SDK drives via `pathToClaudeCodeExecutable`:

- Status: shell `claude auth status` (10 s timeout), JSON-parse stdout, null on any failure — "logged in" detection is exactly "status parses".
- Desktop login: shell `claude auth login` (browser OAuth), wait for exit with a 180 s ceiling. MAT deliberately does not resolve-with-install during sign-in; a missing runtime returns the explicit Setup path.
- Headless three-step login: spawn `claude auth login` with `TERM=dumb`; scrape the OAuth URL from output and **validate its host against a trusted allow-list** (claude.ai / claude.com / anthropic.com) before returning `{url, loginId}`; submit the pasted code via the child's stdin (success = exit 0 without failure markers); cancel kills only the matching in-flight login; error text is redacted (codes and URLs stripped). One login in flight at a time — credentials are host-global.
- Account index: a sanitized read-only JSON index (id/email/subscription only); encrypted credential files are never touched.

This model is *compatible* with MAT's existing "never reads/writes provider credential stores" invariant — MAT, like BAT, only shells the CLI's own auth subcommands. MAT's existing in-app sign-in flows get audited against this shape and aligned.

### 4.2 codex — CODEX_HOME is the auth surface; keys are optional (grounded)

- **OAuth (ChatGPT) is primary and involves no key material in BAT's hands**: codex itself reads `$CODEX_HOME/auth.json`; BAT only decides *which* CODEX_HOME the app-server process gets. Auth-failure substrings in error notifications ("please log in again", "token_invalidated", "401 unauthorized", …) mark the active account needs-login.
- **`OPENAI_API_KEY` is optional**. BAT uses keyring → file → environment; MAT v0.2.9 intentionally implements the headless baseline `<dataDir>/openai-api-key.bin` (0600) → environment and defers native keyring. The resolved value feeds only the runtime child; login children are spawned without it.
- **Unified account store**: index `<dataDir>/codex-accounts.json` + per-account `<dataDir>/codex-accounts/<id>/auth.json`. The shared CODEX_HOME's `auth.json` is the live identity; **switching accounts copies exactly one file** (store copy → shared `auth.json`) and drops the app-server connection so the next spawn runs as the new identity; capture-current snapshots the live file back into the store; an exit hook re-snapshots. Switch/capture/remove refuse while a login or turn is in flight. There is no logout verb — remove or switch.
- Login uses the existing spawned `codex login` child flow (300 s, cancellable). BAT's in-protocol device-code RPC remains deliberately deferred; do not add it without a new work order.
- MAT adoption: the released v0.2.9 shared-home + copy-only-`auth.json` store lives under MAT's data dir; credential writes require explicit user action or the defined capture/sync lifecycle and are never logged. The development rule "never copy `auth.json` between CODEX_HOMEs by hand" remains; the product switcher is the sole controlled exception.

Standing development rules unchanged: never run real provider login commands to probe output; `codex login --device-auth` discards the default-store login the moment it starts; never log values read from the environment.

## 5. Grok / agy / OpenRouter — same contract, two transport routes (task #24)

BAT has no grok/agy; the directive is uniformity — and the template already exists: **`node-sidecar/src/handlers/codex.mjs` (~850 lines) is BAT's canonical "second provider behind the same contract" module.** The #24 implementation adapts that ownership pattern:

- provider-owned manager/runtime modules with session ownership and FIFO coordination;
- one metadata builder emitting the SAME full-shape `claude:status` meta;
- a native translator feeding content into the one contract bridge; the bridge supplies full status/result/turn-end semantics and maps common tool types onto Claude-compatible names (`command_execution`→Bash, `file_change`→Edit, `web_search`→WebSearch, `todo_list`→TodoWrite) so one UI renders every provider.

Two integration models are used: **(1) session backend** (Claude Agent SDK, Codex app-server); **(2) CLI observation** over an existing headless transport. Grok/Agy now use a shared FIFO `CliSessionManager` over their streaming-JSON/plain transports, with Grok resumable and Agy deliberately non-resumable. Their adapter content still crosses the same canonical bridge, so a later transport swap does not change the durable evidence contract.

Cross-cutting mechanics implemented once include FIFO serialization, queued/live cancellation, strict outcome/usage normalization, full manager status construction, and a single terminal guard. Features not present in the current source (for example a separate clientMessageId protocol) are not claimed.

**Route B — codex-as-runtime for OpenAI-compatible providers (Ted, 2026-07-22: OpenRouter becomes provider #5).** The open-source codex CLI supports custom model providers over OpenAI-compatible APIs, and BAT already exercises this end-to-end: Fugu models run through the *same* app-server with `modelProvider:"sakana"` in `thread/start` and `SAKANA_API_KEY` injected at spawn. That makes the §2 controller a universal agent runtime — codex's sandbox, tools, approvals, and rollouts, our one event contract:

- **grok**: xAI's API is OpenAI-compatible, so a future Codex-runtime profile could run grok models inside Codex's agent loop with `XAI_API_KEY`. That route and a UI transport selector are **not implemented**; the current Grok CLI manager remains the only production transport.
- **OpenRouter (provider #5)**: an OpenAI-compatible aggregator with no CLI or agent runtime of its own — Route B is the only route. The bounded public catalog groups request ids so the UI chooses a model first and a version second; MAT persists and sends the exact selected alias/pinned slug. Custom exact slugs remain available. Tool-calling quality varies per model and is surfaced honestly.
- **agy**: its current exposed machine surface is the existing CLI, so Route A's manager wrap remains authoritative. No OpenAI-compatible Route B is claimed unless the provider later ships and documents one.

Containment: OpenRouter sessions run the same resolved Codex binary under an isolated **MAT-owned CODEX_HOME**. MAT writes only the fixed provider configuration (`model_providers.openrouter`, `base_url`, `env_key`, `wire_api:"responses"`, `requires_openai_auth:false`); Codex may own runtime/session state beside it. MAT never places `auth.json` or key bytes there. `OPENROUTER_API_KEY` is injected only into the child environment and never written by MAT; inherited Codex/OpenAI automation credentials are removed. The user's own `~/.codex` config/auth remain untouched. The pinned-runtime spike confirmed `modelProvider:"openrouter"` on `thread/start` while `turn/start` retains the exact model id without duplicating the provider.

## 6. Evidence-plane mapping (task #25)

The released v0.2.10 implementation is grounded against the unchanged BAT baseline `0e24800`:

- `shared/src/providerEvents.ts` defines the strict, provider-neutral 19-event surface. Every event carries `sessionId`; `claude:status` is always a full `ProviderSessionMeta`; a provider turn accepts exactly one `claude:turn-end`.
- `server/src/providers/contract.ts` is the single mapper. It accepts native contract events or legacy `AdapterContentEvent`, canonicalizes tool names (`Bash`, `Edit`, `WebSearch`, `TodoWrite`), maps provider technical state to system/status evidence, suppresses `claude:history`, and source-redacts provider payloads.
- Adapters remain content-only. `nodeRunner` remains the sole lifecycle writer and owns the ordered pre-running queue, identity stamping, and the one terminal result/error path. Provider result/error/turn-end frames latch into `NodeOutcome.providerTurn`; they never append a duplicate lifecycle. `eventLog.append` remains the only authority for durable `id`, `seq`, and `ts`, appending before broadcast.
- `server/test/providers/contract.test.ts` asserts the schema/projection rules. `tools/evidence/repro-runtime-contract.mjs` plus `fake-codex-runtime.mjs` drives OpenRouter through a built server and asserts exact model/provider routing, thinking + Bash tool + answer evidence, one terminal marker, environment redaction, and byte-equivalent restart replay. `npm run evidence` now contains five instruments in the working tree.

## 7. Phasing (tasks #19–#25)

| Task | Scope | Status at 2026-07-23 |
|---|---|---|
| #19 | This grounded port map | complete |
| #20 | Catalog + managed installer | released across v0.2.5–v0.2.6 |
| #21 | Codex app-server controller; explicit exec legacy mode | released in v0.2.7 |
| #22 | Claude Agent SDK runtime; explicit CLI legacy mode | released in v0.2.8 |
| #23 | Auth/account alignment | released in v0.2.9 |
| #24 | Grok/Agy managers + OpenRouter through Codex-as-runtime | released in v0.2.10 |
| #25 | Canonical event mapping + fifth evidence instrument + release | released in v0.2.10 |

## 8. Tracking BAT updates (跟著他的更新走)

Before starting any phase (and periodically after):

1. `git -C /tmp/mat-refs/better-agent-terminal fetch && git -C … pull --ff-only` (re-clone if the scratch dir is gone).
2. Diff since the recorded head: `runtime-catalog.json`, `scripts/sync-runtime-catalog.mjs`, `src-tauri/src/{runtime_install,runtime_catalog,codex_app_server,codex_auth,codex_account_store}.rs`, `node-sidecar/src/{handlers,runtimes,lib}/`.
3. If BAT bumped pinned runtime versions: bump MAT's matching dependencies, run `npm run sync:runtime-catalog`, let the guard test prove the catalog matches.
4. If BAT changed adapter behavior: port the change, note the new head SHA below.

| date | BAT head | note |
|---|---|---|
| 2026-07-22 | `0e24800` | baseline for this plan |
| 2026-07-23 | `0e24800` | rechecked for #24/#25; relevant BAT head unchanged; MAT implementation released in v0.2.10 |
