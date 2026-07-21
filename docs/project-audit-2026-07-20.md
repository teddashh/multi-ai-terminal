# Project audit and continuation backlog — 2026-07-20

This document records the whole-project audit performed immediately after the
v0.1.9 handoff, the hardening implemented in the same working tree, and the
subsequent v1.4 evidence-workbench slice packaged for v0.2.0. The product
manifests report 0.2.0. It is a planning and risk record, not authorization to
expand product scope; GitHub remains authoritative for publication state.
`HANDOFF.md` remains the operational entry point and code remains authoritative.

## Product direction confirmed

MAT is a workbench for orchestrating headless CLI coding agents. The absence of
a PTY is deliberate. Its durable advantage is the quality of evidence produced
by one node and the fidelity of the handoff consumed by the next, not UI breadth
or interactive-terminal emulation.

The original handoff baseline passed 35 Vitest files / 226 tests, typecheck, and
the real-browser smoke on Linux, and the last remote main build was green on
Linux and Windows. That baseline was useful but not sufficient: this audit also
found latent security, engine-state, evidence-provenance, replay, and release
correctness defects that the existing gates did not exercise. Green tests must
therefore be read as evidence for named contracts, never as proof that the whole
engine is healthy.

The final local integrated verification of this v0.2.0 release snapshot passed
version synchronization, production build, 47 Vitest files / 317 tests, full
typecheck, all four independent evidence instruments, and the real-Chromium
smoke on Linux. Normal remote Linux/Windows CI remains a release prerequisite;
local green evidence is not a claim that the working tree has shipped.

## UX references and boundary

The v1.4 design review checked the latest heads available on 2026-07-20 for
[TempoTerm](https://github.com/mukiwu/tempo-term) (`0bed0f9`),
[Better Agent Terminal](https://github.com/tony1223/better-agent-terminal)
(`b09639c`), and
[multi-ai-chat-desktop](https://github.com/teddashh/multi-ai-chat-desktop)
(`4e98c06`, the v1.7.0 merge) as hierarchy/status/focus interaction references:

- TempoTerm demonstrates project-first navigation, glanceable activity and
  worktree context, stable docked side regions, and direct context-local actions.
- Better Agent Terminal demonstrates a dominant agent work surface, supporting
  workspace/settings panes, presets for common entry paths, compact live status,
  and technical output that expands only when needed.
- multi-ai-chat-desktop demonstrates the owner's familiar conversation-first
  hierarchy, visible workflow controls, readable results, replay/diagnostic
  affordances, and streaming state that protects focus and current selection.

MAT borrows that hierarchy/status/focus mental model only. Their PTY, terminal
aggregation, editor/file/Git/SSH surfaces, WebView automation, remote clients,
session pause/resume, and other product breadth are not implied work. MAT
remains a headless CLI orchestrator whose reason to exist is evidence and
handoff quality.

## Unpublished v1.4 evidence-workbench slice

This slice changes how existing MAT capabilities are configured, diagnosed,
and read; it does not change the headless provider contract or create a release:

- The equal four-column shell is now a 52 px navigation rail, a persistent and
  collapsible Launchpad, a persistent and collapsible activity inspector, and a
  flexible Run Workspace. Projects and Launch are two views of the same
  mounted Launchpad. Independent side widths are persisted and fitted so the
  workspace retains at least 320 px at the supported compact viewport.
- Launch follows progressive disclosure: mode, readiness, bound providers,
  task, and Start stay on the common path; advanced stage/orchestrator/agent
  editing moves into a focus-trapped Customize drawer. Builtin edits remain
  run-scoped until explicitly duplicated.
- Run Workspace owns one run selector and replay loader for both Conversation
  and Timeline. Shared All/Running/Attention and per-node controls focus the
  activity and evidence surfaces together without changing the active run.
- Conversation is the default readable projection. It carries stable
  node/provider/model/stage/attempt/sequence identity, hides technical detail by
  default, and makes decisions, verification, errors, and gaps prominent.
  Timeline remains the raw searchable/filterable renderer.
- Health groups read-only server, workspace, provider, viewed-run, node,
  verification, WebSocket, and evidence-integrity findings. Provider discovery
  is never presented as proof of authentication; diagnostic actions inspect or
  export redacted evidence and do not mutate a run.

### Load-bearing UI seams

- `App.tsx` owns boot, the active-run WebSocket subscription, top-level status,
  Abort, Health, and `AppShell`; it must not turn transport connectivity into an
  authentication or evidence-completeness claim.
- `AppShell.tsx` owns geometry and mount lifetime. Collapse hides the inner
  content while retaining every outer grid cell and mounted subtree. This is
  required both for draft preservation and CSS grid placement. Its persisted
  widths, keyboard dividers, pointer cleanup, and compact-width fitting are one
  contract, guarded in jsdom and real Chromium.
- `RunWorkspace.tsx` owns viewed-run selection, Conversation/Timeline mode,
  node focus presets, and replay generations. Neither child evidence panel may
  introduce a competing selector or loader.
- `store.ts` owns the separation of `activeRunId` and `viewedRunId`, the bounded
  event ring, live recovery state, and stable selector values. Fresh fallback
  arrays/objects in selectors remain forbidden because of the React #185 loop.
- `narrativeLogic.ts` is a reversible readable projection;
  `streamLogic.ts` is the raw ordering/filter/grouping contract; `RunPanel.tsx`
  is the mounted activity/action inspector; `HealthDrawer.tsx` is read-only
  troubleshooting. Keep those responsibilities separate.

### Replay, live continuity, and ordering rules

- Persisted `AgentEvent.id`/`seq` are immutable and `seq` is authoritative.
  Narrative may merge only adjacent compatible message/thinking continuations
  and identity-compatible tool halves. Every source event appears exactly once,
  sequence ranges remain visible, and a missing range becomes an explicit gap.
- Timeline retains each raw source event. Tool use/result and identical fan-out
  user prompts may be visually grouped only when adjacent and compatible; the
  group retains its source events in monotonically increasing order. A delayed
  tool result stays after every intervening event. Filtering and search do not
  authorize reordering.
- `activeRunId` drives subscription/control and `viewedRunId` drives reading.
  Choosing history never detaches the live run. Replay uses bounded pages and
  generation guards; stale loads stop after their in-flight request. The UI ring
  is bounded, while the server event log and debug bundle remain complete.
- A live sequence jump pauses the completeness claim, buffers simultaneous
  WebSocket arrivals, backfills persisted REST pages, merges/deduplicates by
  sequence, and preserves the earliest unresolved cursor. Initial/reconnect
  catch-up reports the same `recovering` → `live` or `incomplete` lifecycle.
  Failure remains visible in Conversation and Health, and Conversation offers
  explicit Retry; it is not reduced to a console warning. Transport state and
  evidence integrity stay separate.

## Release history corrections

The GitHub release state was checked directly:

- v0.1.0 predates Windows packaging. It has Linux and both macOS architectures,
  seven assets total, and no release notes.
- v0.1.1–v0.1.3 have the four supported platforms and nine assets, but no
  release notes.
- v0.1.4–v0.1.9 have four-platform artifacts and bilingual release notes.
- v0.1.9 became public at 10:31:59Z, before the last matrix assets arrived at
  10:34:14Z. This concrete partial-release window is why publishing is now
  draft-first.

Historical tags also show why version synchronization must be enforced: the
v0.1.1 tag reported 0.1.1 in the JavaScript and Tauri manifests while
`Cargo.toml` still reported 0.1.0.

## Correctness and safety repairs in this audit pass

### Persisted-output privacy and honest terminal state

- Provider auth-failure parsing no longer copies any CLI-supplied line that
  mentions keys, tokens, secrets, or equivalent credential material into
  `errorReason`. A synthetic API-key sentinel guards the prose-shaped leak that
  exposed the original defect.
- A shared sink-boundary redactor now covers environment values in newly
  appended event text, tool fields, nested event data, diagnostics, persisted
  node prompts/raw/results/errors, and verification commands/output/logs/results.
  Exact fields and distinctive embedded machine values are covered for every
  environment name; credential-bearing names are covered at every length.
  Trusted protocol structure is kept separate from untrusted text, so a known
  engine version or enum is not destroyed by a coincidental host value and
  there is no generic payload-field allowlist. Providers
  still receive and execute original input; only evidence at rest is sanitized.
  The persistence rule also applies
  to `mock`, without enabling real-provider auth behavior for it.
- Report responses are redacted at the route boundary. Debug-bundle redaction
  covers `run.json`, events, reports, diagnostics, server diagnostics, raw logs,
  patches, and verification artifacts, including legacy files. A synthetic
  credential sentinel is scanned across every zip entry and the report route.
  Large raw/patch/verification/diagnostic entries are sanitized as lazy streams,
  including a fixture whose value crosses a read-chunk boundary.
- Captured Git patches remain byte-faithful internal execution artifacts so
  verification and Apply patch cannot silently install `[REDACTED_ENV]` in place
  of source text. Only presentation and export copies are sanitized; a real Git
  round-trip test locks the distinction.
- Desktop startup diagnostics and rendered startup errors are redacted before
  they are logged. The selected Node executable is described by source rather
  than logging a potentially sensitive environment-variable value.
- An artifact-capture/finalize exception can no longer leave a successful node
  marked `done`. The node becomes `failed`, carries explicit
  `artifact-capture-failed` verification evidence, emits the error lifecycle,
  and remains eligible for the normal retry policy.

### Gate, retry, steer, and orchestrator identity

- `requireVerified` now applies even when orchestration is disabled. When no
  candidate passed, failed/error verification candidates are targeted for retry;
  exhausted retry budgets produce an explicit degraded advance instead of a
  silent fail-open.
- A steer-review retry resets only the node IDs selected by the gate decision.
  Non-targeted interrupted nodes retain their killed attempt and evidence.
- Orchestrator node/event attempts and raw filenames are now run-global, so
  decisions across multiple stages cannot collide. `GateDecision.gateAttempt`
  remains correctly scoped per stage.
- `appendDecision` now freezes additive verification counts on each
  `GateDecision`. Run cards and Markdown reports prefer that historical snapshot,
  so later retries cannot rewrite how an earlier gate appears; persisted legacy
  decisions retain a current-node fallback.

### Immutable run provenance and deletion safety

- New runs capture an additive, optional `workspaceSnapshot` containing the
  evidence-relevant workspace name, path, Git state, and verification settings.
  Stage execution, steer cycles, terminal retries, verification, patch apply,
  cleanup, reports, and debug bundles all use this immutable snapshot, so later
  workspace edits or deletion neither redirect work nor rewrite provenance.
- Workspace deletion returns 409 while any run is active. It also refuses to
  orphan a legacy terminal run that predates embedded provenance; the user must
  explicitly delete that run first. Snapshot-bearing terminal runs keep their
  report/debug evidence after workspace deletion.

### Live selection, replay, and evidence visibility

- The web store separates `activeRunId`, used for live subscription/control,
  from `viewedRunId`, used by both Run and Stream panels. Selecting history no
  longer detaches or visually replaces the active run, and workspace/history
  generation guards discard stale asynchronous responses.
- A terminal-only reload selects and renders the newest run, including node,
  handoff, patch, Report, and Debug evidence. The real-Chromium smoke now covers
  reload and Report access through the UI. Historical Report, Debug, and Patch
  actions are bound to the viewed run, and stale async results are discarded if
  the user changes runs before they return.
- A delayed create-run response may still be recorded, but it can no longer
  switch live/view selection back to a workspace the user has already left.
- Switching workspaces clears the task draft and any builtin workflow override,
  so run-scoped configuration cannot be submitted accidentally against a
  different repository. Unsaved edits to a custom, globally stored workflow
  remain available for an explicit save.
- The 20,000-event bound applies to both live and replay views. Terminal replay
  scans persisted evidence to the newest window without withholding already
  loaded rows; the complete immutable stream remains available from the server
  and debug bundle without risking an unbounded browser heap.
- Event pagination builds a sparse sequence-to-byte index in bounded chunks and
  reads each page from its nearest checkpoint. Long terminal replays are linear
  rather than repeatedly materializing and rescanning the whole JSONL file;
  switching views stops the stale page chain after its in-flight request.
- The former live-gap backlog item is complete in this working tree. A sequence
  jump enters visible `recovering`, buffers concurrent frames, backfills from
  the earliest missing cursor, merges/deduplicates by `seq`, and either returns
  to `live` or remains visibly `incomplete` with Retry. Initial and reconnect
  catch-up use the same integrity lifecycle; failures expose a generic message
  rather than persisting or rendering transport exception values.
- The former ordering/tool-grouping backlog item is also complete. Narrative
  retains a reversible source list and explicit gaps while merging only adjacent
  compatible continuations. Timeline preserves raw source identity; tool halves
  and duplicate fan-out prompts receive adjacent-only visual grouping, so a
  delayed result never jumps across intervening evidence and the source order
  expands monotonically after filtering/search.
- Structured multi-line `errorReason` guidance is no longer line-clamped. Raw
  unstructured errors retain the three-line clamp.
- The composer emits non-blocking readiness warnings for every
  `requireVerified` stage missing an enabled gate, worktree isolation, and/or a
  workspace `verifyCommand`. This keeps evidence quality visible without
  inventing a new policy that blocks run creation.

## Release, evidence, and documentation hardening

### Version and dependency integrity

- `scripts/verify-version.mjs` checks the six authoritative product versions:
  root/server/web package manifests, Tauri config, Cargo package, and the server
  `VERSION` constant.
- It also checks root/server/web metadata in `package-lock.json` and, when
  `MAT_EXPECT_TAG` or `--tag` is provided, requires the release tag to equal
  `v<version>`. Vitest fixtures cover matching, multiple mismatch, tag mismatch,
  and invalid-version paths.
- `@fastify/static` was raised to the patched Fastify-5-compatible 9.x line. A
  regression test proves an encoded slash cannot cross a protected route and be
  decoded by the static wildcard.

### Deterministic evidence and safer publication

- `tools/evidence/run-all.mjs` and `npm run evidence` run all four independent
  black-box instruments and print a final per-instrument summary.
- `repro-v018.mjs` uses a sparse deterministic PATH: only a resolved Git
  executable is inherited, fake-home `agy` proves augmented-PATH discovery, and
  a controlled failing `grok` proves probe diagnostics. Installed user CLIs can
  no longer change its result. Its working-tree version comes from the root
  manifest; extracted artifacts still use explicit `MAT_EXPECT_VERSION`.
- CI verifies version synchronization before build and runs the evidence suite
  on Linux in addition to Linux/Windows tests, typecheck, and browser smoke.
- Child-process tests now carry explicit 30-second budgets, deadline-based
  process-death polling, and retrying cleanup to match Windows CI behavior.
- Release jobs verify the tag. The Linux job reruns tests, typecheck, evidence,
  and browser smoke, while Tauri creates a draft release. Bilingual notes and
  extracted-deb verification now precede an explicit publish step.

### Documentation repair

- The product spec now identifies v1.4, recognizes the shipped Tauri/Windows
  surfaces, lists current evidence/debug APIs, documents the WebView2-safe model
  combobox, includes Pipeline, and uses the real browser/evidence acceptance
  commands. Its old codex-fleet build waves are explicitly historical and
  non-normative; they no longer freeze the store or grant file ownership.
- The Traditional Chinese README now covers Browse, provider Setup, augmented
  PATH, OAuth-race guidance, and v0.1.9 auth visibility.
- HANDOFF records the actual release history and the draft-first playbook.

## Open backlog, ordered by evidence risk

### 1. Bounded evidence materialization

Report generation and debug-bundle creation still have callers that request
`Number.MAX_SAFE_INTEGER` events and materialize the complete parsed history.
Large real runs can therefore turn an evidence export into a memory/latency
failure. Define bounded or streaming event/report readers and writers without
changing chronological order or omitting artifacts.

The UI heap is bounded, stale replay chains stop after their current request,
and per-page reads now use a sparse byte index. Selecting a terminal run still
issues sequential pages from the beginning to reach the newest window, while
the index's first build is a synchronous linear scan. Add a tail-aware cursor or
persisted index and explicit multipage/cancellation fixtures. Raw, patch,
verification, and run-diagnostic bundle entries now redact through lazy streams;
preserve that property when the event/report paths are converted.

### 2. Broader legacy privacy corpus and installer invariant

The synthetic sentinel now covers every current report/debug entry, but one
fixture cannot represent every historical or unknown persisted data shape.
Extend the compatibility corpus with sanitized legacy bundles and unexpected
text-bearing artifact entries, and require the export boundary to remain safe
without corrupting stable metadata.

Provider installation also needs one evergreen invariant suite: only an
explicit endpoint call may run a known fixed recipe, arbitrary provider IDs and
all user-supplied command/argument fields must remain impossible, and `mock`
must remain exempt from real-provider behavior.

### 3. Remote bearer-token mode has no product UX

REST and WebSocket clients read `mat-token` from `sessionStorage`, but the app
has no visible way to set, replace, or clear it; no connection/authentication
status; and no guided recovery after a 401 or rejected WebSocket. A user who
starts the server with `--token` must currently seed storage out of band. Add a
small connection/auth surface before treating remote mode as operable: keep the
secret session-scoped, never render or log its value, distinguish unreachable
from unauthorized, reconnect both transports after an update, and provide an
explicit clear action.

### 4. Packaged desktop launch smoke

The browser smoke starts Fastify directly in Chrome, and the artifact suite
boots `server/dist/index.js` from the working tree or extracted deb. Neither
exercises Tauri's Node discovery, resource path resolution, native plugin
registration/permissions, WebView navigation, or installer launch. Past
v0.1.2/v0.1.3 failures lived in this gap. Add the smallest installed-binary
probe per platform, starting with Windows, without removing the Chrome smoke.

### 5. Persisted-schema compatibility corpus

Shared zod contracts are strict and may evolve only additively, while current
tests mostly round-trip current objects. Check in sanitized persisted
workspace/workflow/run/event fixtures from v0.1.6–v0.1.9 and require current
schemas and loaders to accept them. Include legacy runs without
`workspaceSnapshot` and new snapshot-bearing runs.

### 6. Minimum runtime and Rust reproducibility

Packages promise Node >=20 while primary CI uses Node 24. Add a focused Node 20
Linux lane for the supported minimum, keeping the primary Linux/Windows browser
lanes. Rust builds have no committed `Cargo.lock` and use floating stable
toolchains plus mutable action tags, so a rebuild can resolve different code.
Decide whether to commit the lock and use `--locked`; independently pin release
actions/toolchains and record provenance or checksums for shipped assets.

### 7. Positive black-box auth lifecycle

`repro-v019` proves advertised sign-in metadata and the required negative path
for `mock`, while unit/integration tests cover real-provider detection. Artifact
evidence still does not drive a fake real CLI through failure → `errorReason` →
provider alert → report → later-success clearing. Extend the evergreen v019
contract when doing so; do not mint `repro-v020` until new released behavior
exists.

### 8. UI labels, accessibility, and release hygiene debt

Counted nodes now derive the same stable `#1`/`#2` instance ordinal in
Conversation, Activity, Run Workspace filters, Timeline filters, gate retry
labels, patch titles, and Health without changing persisted labels or
`nodeRunId` identity.

Run dialogs still need focus trapping, Escape handling, and focus restoration.
Follow-mode intent is strongest for mouse-wheel input; keyboard, touch, and
assistive scrolling need equivalent fixtures before calling the stream controls
fully accessible.

Draft-first publication remains intentionally manual: notes, extracted-deb
evidence, and publish are separate human gates. If this is later automated,
verify uploaded artifacts in one final dependent job and never trade away the
atomic publication boundary merely to reduce clicks.

## Explicitly deferred — do not implement without Ted asking

- pause/resume
- human-approval nodes
- steer-time agent picker
- live adapter contract tests requiring real credentials
- multi-pane or canvas layouts
- UI internationalization
- PTY or interactive-terminal mode

Pre-tool policy hooks also remain outside the evidence-plane contract unless a
separate trust/lifecycle design is approved. These items are not implied by the
hardening backlog above.

## Recommended continuation order

1. Complete integrated validation and observe this audit branch in normal CI
   without changing the product version.
2. Bound event/report/debug materialization.
3. Add the persisted-schema compatibility corpus and broaden the legacy
   privacy/installer invariant fixtures.
4. Design the remote bearer-token connection/auth surface without ever exposing
   the token value.
5. Design packaged Windows launch evidence and close Node 20/Rust build
   reproducibility gaps.
6. Choose the next evidence/handoff product slice from real debug bundles. Do
   not mint a version or tag until released behavior and its instrument are both
   defined.
