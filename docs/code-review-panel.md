# Code Review Panel — integrate @ b704c08 (2026-07-18)

Four independent seats reviewed the fully integrated tree (typecheck green, 120/120 tests, live mock smoke green) against SPEC.md v1.1. External CLIs ran read-only in the repo; every finding below was then independently verified against the code by the Claude Fable 5 seat before entering the fix queue.

## Seats

| Seat | Mode | Result |
|---|---|---|
| grok-4.5 | `grok -p` in repo, high reasoning | 12 findings — **12 confirmed** (2 critical, 6 major, 4 minor) |
| codex gpt-5.6-sol | `codex exec --sandbox read-only`, high effort | 16 findings — **12 new confirmed** (1 critical), 3 duplicates of other seats, 1 referred to spec-wording check |
| Gemini 3.1 Pro | `agy -p` in a disposable clone | 5 findings — 2 confirmed, 1 downgraded to hygiene, **2 refuted** |
| Claude Fable 5 | direct adjudication + own deep read (engine, adapters, auth/path/spawn security pass) | all cross-verifications + 2 own findings; security pass clean |

First run of the panel was disrupted by a transient machine-wide HTTPS outage (~11:30 EDT) that killed the codex and agy seats mid-flight; both were relaunched cleanly after connectivity returned. grok's review completed through the outage.

## Confirmed findings (fix queue: 25 items)

### Critical
1. **runManager.createRun** registers the live snapshot only via `queueMicrotask` — an immediate `abortRun` mutates a separate disk copy and the run later resurrects to `running`. *(grok #1)*
2. **nodeRunner** — a node inside `prepare()` (worktree creation) is invisible to `killAllActiveNodes`; it spawns after abort and overwrites `killed`→`running`. *(grok #2)*
3. **shared workflow schema** — `Stage.id`/`Slot.id` accept path separators, so a crafted `workflowOverride` produces nodeRunIds that escape the run directory for raw logs / artifacts / worktree paths. *(codex #1)*

### Major
4. `retryStage` unserialized — concurrent terminal retries double-execute the stage. *(grok #3)*
5. Event ring: `loadOlderEvents` prepends history then `slice(-20000)` discards it; >20k-event replay/scroll-back unreachable, silently. *(grok #4/#5, codex #12)*
6. Race-window engine failures throw bare `Error` → HTTP 500 instead of 409/404 (killNode on finished/queued node; retry during decision window). *(grok #6/#8, agy #3, codex #10)*
7. `control.gating` flips false before `run.status` leaves `gating` — user retry in the window fails. *(grok #7)*
8. Fire-and-forget `void persist()` sites — a disk-write failure becomes an unhandled rejection and crashes the server. *(agy #1, codex #7)*
9. Queued nodes cannot be killed and later spawn anyway. *(agy #3, codex #10; folded into 2+6)*
10. eventLog torn-tail recovery appends onto the unterminated fragment, corrupting two events. *(codex #3)*
11. spawn close-path assumes the process group died with the child; surviving descendants are never reaped. *(codex #4)*
12. `sweepOnBoot` sends SIGTERM only — no SIGKILL escalation for TERM-ignoring stale groups. *(codex #5)*
13. Hard/stall timers armed only after `await persist()` — slow saves let a CLI overrun `timeoutSec`. *(codex #6)*
14. `applyPatch` check-then-apply unserialized per workspace. *(codex #8; 3-way conflict markers on real conflicts kept — that is the §8 contract)*
15. Patch files written non-atomically at their final path. *(codex #9)*
16. Web boot never discovers an existing active run — browser reload loses live monitoring. *(codex #11)*

### Minor
17. Digest tool-call counts accumulate across attempts. *(grok #9)*
18. `sessionRef` survives retry resets (retries are fresh spawns). *(grok #10)*
19. Coalescer `continued:true` wrongly set on the first chunk after a kind change. *(grok #11)*
20. User-requested stage retry logs the orchestrator kill as `gate-timeout`. *(grok #12)*
21. `git apply --check --3way` needs git ≥ 2.32 — fallback + README note. *(fable #1)*
22. Boot-recovery restart event not idempotent across crash-during-sweep. *(codex #13)*
23. Gated stage with orchestrator disabled records no deterministic advance decision. *(codex #14)*
24. Web retry-button validity ignores attempt-based budgets for ungated stages. *(codex #15)*
25. Workspace paths stored unnormalized (`/a/../b`); resolve + realpath to canonical form. *(agy #5, codex #16 — hygiene for a local-trust tool, not a traversal boundary)*

Referred to spec check during fixes: decision events currently stamp the evaluated `stageId`; codex seat read SPEC as requiring `stageId:null` on all orchestrator-identity events. Fixer rules per SPEC wording.

## Refuted claims (no change made)

- **"digest truncation keeps the wrong end"** *(agy #2)* — SPEC §5.1: resultText "(tail-truncated with `…[truncated]`)": head is cut, tail kept; CLI conclusions live at the tail. Implementation matches.
- **"manual retry at the final gate attempt silently degrades"** *(agy #4)* — `retryStage` rejects manual retries once `decisionCount ≥ maxRetriesPerStage`, so the degrade branch only ever converts LLM retry decisions, which is the §5 budget-exhaustion contract.
- **pid-recycling in `sweepOnBoot` after machine reboot** *(fable #2)* — accepted v1 risk, recorded in README known limitations.

## Security pass (Fable seat)

- REST bearer guard scoped to `/api/*` when `--token` set; WS at `/ws` uses query-token check (no Authorization-header conflict with browser WS upgrade). ✓
- Workspace path validation: absolute + directory + (post-fix) canonicalized. ✓
- All child processes spawned argv-array via `spawn()`, prompts delivered over stdin — no shell string interpolation anywhere. ✓
- Template variables render into prompt text only, never into command lines. ✓
