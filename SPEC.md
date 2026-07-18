# Multi-AI Terminal — Product & Engineering Spec (v1.1)

> v1.1 incorporates the 4-model panel review (codex gpt-5.6-sol, agy Gemini 3.1 Pro, grok 4.5, Claude Fable 5 — all verdicts: revise; findings merged, see docs/spec-review-panel.md).
> Date: 2026-07-18

## 0. What this is

**Multi-AI Terminal (MAT)** is a workflow-orchestration workbench for **CLI coding agents** (claude, codex, grok, agy). The user composes a workflow (e.g. *Planning Mode*: Orchestrator → Round-Table candidates → Final Reviewer), drags agents onto workflow checkpoints, and watches every agent's live, categorized message stream (**your / agent / tool / thinking**), while a real LLM orchestrator monitors the run and decides advance/retry at each gate.

Successor concept to `multi-ai-chat-desktop` (webchat orchestration), rebuilt on the CLI/agent-SDK path. **Not** a terminal emulator, **not** a fork of better-agent-terminal.

### Decisions locked by the 12-round design debate (do not relitigate)

1. **Do not reuse multi-ai-chat-desktop's runtime** (webview automation). Borrow only UI mental model + design tokens.
2. **Single primary data stream = headless JSONL.** Every workflow node runs its CLI non-interactively. No interactive PTY, no ANSI parsing, no xterm.js in v1. *(Note: the debated "read-only raw-PTY pane" fallback for non-JSONL CLIs is superseded by the `plain` tier in §4.4 — same observability, less machinery.)*
3. **Per-provider adapters normalize output to one internal event schema.** Hard-coded mappings per CLI. CLIs without JSON output (agy) are `plain` tier: stdout streams in as chunked agent text.
4. **Presentation layer is a styled message panel** (React list, four categories + status). This is the product's differentiation, written from scratch.
5. **Orchestrator = a real LLM agent, minimum-branch.** Deterministic trunk (fan-out stage → join → gate → next stage); the LLM decides only at gates: advance / retry(nodes, addendum) / abort, emitting a machine-parseable decision + rationale (decision log is first-class UI data).
6. **Turn-based coordination via job queue + files.** No realtime stdin injection. Fan-in compares normalized events/artifacts.
7. **Node schema is provider-agnostic from day 1.** Multiple instances of one agent at one checkpoint (e.g. 3× grok) is a core interaction.
8. **Mid-run human intervention v1 =** kill node, retry stage, abort run, apply patch. No typing into a live agent session.

### Non-goals (v1)

Interactive terminals/stdin; dynamic runtime graph growth (only retries of existing nodes); Tauri/Electron packaging (localhost web app; §2); Windows; graph-canvas editing (form-based editing + drag-to-assign); i18n; auth beyond network trust + optional token; `gemini` as a separate provider (agy serves Gemini models; dedicated gemini-cli adapter is v1.1).

## 1. Primary user story

Ted opens MAT on castle1 via browser (Tailscale). Left rail shows workspaces (repos) with the last workflow mode each ran. He picks a workspace, selects **Planning Mode** (builtin), drags `codex` and two `grok` chips onto *Round Table* **directly on the builtin** (edits are an ephemeral run-scoped copy; "Duplicate" only to save), sets one candidate's model/effort, types the task, hits **Run**. Node cards light up; the stream panel shows every agent's your/agent/tool/thinking messages live (aggregated feed; click a node card to focus it — true side-by-side panes are v1.1). At the gate, the Orchestrator's decision card explains why R2 is retried with an addendum. The Final Reviewer produces the consolidated plan; the run is replayable after a server restart.

## 2. Architecture & stack

**Topology: single Node.js server process + browser UI.**

- Server: **Node ≥ 20, TypeScript, Fastify** (REST + WebSocket + static hosting). Spawns agent CLIs as child processes, parses stdout line-by-line, persists + broadcasts normalized events.
- Frontend: **React 18 + Vite + TypeScript + Tailwind CSS + zustand + @dnd-kit/core + @tanstack/react-virtual**. Backend touchpoints ONLY via `web/src/api/client.ts` (REST) and `web/src/api/ws.ts` (WS).
- Shared package: **zod schemas + TS types** consumed by both sides.
- Monorepo: npm workspaces (`shared/`, `server/`, `web/`). ESM, TS strict. Engines `>=20`.

Why web-served instead of Tauri: Ted's fleet is headless servers over Tailscale; BAT needs an xvfb hack there. A web app is natively headless, e2e-verifiable by agents, wrappable in Tauri later. *(Deviation from debate round 12, deliberate: "reuse BAT peripheral scaffolding" was dropped because BAT is Tauri-bound; its lifecycle/worktree patterns are re-specified natively here.)*

**Bind & trust**: default `--host 127.0.0.1`. `--host 0.0.0.0` (or a tailscale IP) opts into remote access; v1 trust model is the network boundary (tailnet ACLs). Optional `--token <secret>` (or `MAT_TOKEN`): when set, REST requires `Authorization: Bearer <secret>` and WS requires `?token=<secret>`; when unset, no auth. Server never exposes itself beyond the chosen bind.

### Repo layout

```
multi-ai-terminal/
├── package.json                # workspaces root; scripts: dev, build, test, start, typecheck
├── SPEC.md  README.md  LICENSE  docs/spec-review-panel.md
├── shared/
│   └── src/
│       ├── events.ts workflow.ts run.ts providers.ts api.ts   # types + zod (normative, §3)
│       ├── presets/planning.json build.json review.json       # §10
│       └── index.ts
├── server/
│   ├── src/
│   │   ├── index.ts            # mat-server [--port 7788] [--host 127.0.0.1] [--data-dir …] [--token …]
│   │   ├── spawn.ts            # §4.6 sanitized-env process-group spawn
│   │   ├── adapters/           # base.ts claude.ts codex.ts grok.ts agy.ts mock.ts registry.ts
│   │   ├── engine/             # runManager.ts stageRunner.ts nodeRunner.ts digest.ts worktree.ts
│   │   ├── orchestrator/       # gate.ts decision.ts prompts.ts
│   │   ├── store/              # dataDir.ts workspaces.ts workflows.ts runs.ts eventLog.ts
│   │   └── api/                # routes.ts wsHub.ts
│   └── test/                   # vitest; fixtures/ = cleaned REAL CLI captures (§11)
└── web/
    └── src/
        ├── app/                # App shell, layout grid, theme, store.ts (zustand — FROZEN in wave 0)
        ├── api/                # client.ts ws.ts
        ├── components/         # AgentChip StatusDot ModalDialog Collapsible EventRow… (FROZEN in wave 0)
        ├── panels/workspace/   # left rail
        ├── panels/workflow/    # mode picker, stage editor, agent palette, run box
        ├── panels/run/         # node cards grid + gate decision cards
        └── panels/stream/      # aggregated feed, filters, replay
```

## 3. Shared contracts (normative — wave-0 implements these EXACTLY; wave-1 may not edit)

### 3.1 Normalized event schema

```ts
// shared/src/events.ts
export type EventRole = 'user' | 'agent' | 'tool' | 'thinking' | 'system' | 'decision';
export type EventKind =
  | 'message' | 'thinking' | 'tool_use' | 'tool_result'
  | 'status'      // data: { status: NodeRunStatus | 'spawned' | 'retry', detail?: string, attempt?: number }
  | 'decision'    // data: GateDecision
  | 'error'       // data?: { exitCode?: number|null }
  | 'result';     // data: { exitCode: number|null, usage?: Usage, sessionRef?: string }

export interface Usage { inputTokens?: number; outputTokens?: number; costUsd?: number }

export interface AgentEvent {
  id: string;                // nanoid — assigned by eventLog.append
  seq: number;               // monotonic per run — assigned by eventLog.append
  runId: string;
  stageId: string | null;    // null: run-level events and the orchestrator node
  nodeRunId: string | null;  // null: run-level system events
  attempt: number;           // attempt this event belongs to (1-based; 0 for run-level)
  role: EventRole;
  kind: EventKind;
  text: string;
  tool?: { toolCallId?: string; name: string; input?: string; output?: string; isError?: boolean };
  data?: Record<string, unknown>;
  ts: number;                // epoch ms — assigned by eventLog.append
}
```

**Pipeline ownership rules (normative):**
1. **Adapters emit CONTENT events only** (`message`, `thinking`, `tool_use`, `tool_result`) via `onEvent` with fields `{role, kind, text, tool?, data?}`. They never emit lifecycle events and never touch identity fields.
2. **nodeRunner (engine) emits ALL lifecycle events**: the synthesized `role:'user', kind:'message'` prompt event (see rule 3), `status` (`spawned`/`running`/`stalled`/`retry`/`killed`), `result`, `error` — all with `role:'system'` except the user prompt event. It stamps `runId/stageId/nodeRunId/attempt` on every event (adapter or lifecycle) before append.
3. **The engine synthesizes the 'your' category**: at every attempt start (initial + each retry), BEFORE `status:spawned`, it appends a `role:'user', kind:'message'` event whose text is the final rendered prompt (with retry addendum when applicable). No CLI echoes prompts; without this rule the headline "your" category would be empty.
4. **eventLog.append is the single writer** (§7): per-run FIFO queue; assigns `id/seq/ts`; appends durably to `events.jsonl`; ONLY THEN `wsHub.broadcast(event)`. Synchronous interface: `appendEvent(runId, partial): AgentEvent`.
5. **Events are immutable.** Streaming deltas (grok tokens, agy stdout) are coalesced per (nodeRunId, kind) and flushed on kind-change, ≥1500 ms, or ≥2 KB buffer — each flush appends a NEW event with `data:{continued:true}` after the first. The EventRow renderer AND the digest builder MUST merge runs of consecutive events with equal `(nodeRunId, attempt, kind)` into one visual/logical block.
6. Non-JSON stdout lines from `rich`-tier CLIs are silently skipped for normalization but always land in the raw log.
7. Every raw stdout/stderr line is appended verbatim to `raw/<nodeRunId>.a<attempt>.jsonl` as `{s:'out'|'err', l:string, ts:number}`.

### 3.2 Workflow definition

```ts
// shared/src/workflow.ts
export type ProviderId = 'claude' | 'codex' | 'grok' | 'agy' | 'mock';
export interface AgentBinding {
  provider: ProviderId;
  model?: string;                       // free text; UI suggests via /api/providers
  effort?: 'low' | 'medium' | 'high' | 'xhigh';   // mapped per provider; ignored where N/A
  permission: 'safe' | 'auto' | 'full';           // §4.5
  systemPromptAppend?: string;
  maxTurns?: number;
}
export interface Slot {
  id: string; label: string;            // "R1", "Final Reviewer"
  agent: AgentBinding;
  count: number;                        // 1..8 fan-out instances
  promptTemplate: string;               // §6.2
}
export interface Stage {
  id: string; name: string;
  slots: Slot[];                        // Σ slot.count ≤ 12 per stage (zod-enforced)
  isolation: 'none' | 'worktree';
  join: 'all';
  timeoutSec: number;                   // default 1800 — per-attempt hard kill
  stallSec: number;                     // default 240 — see §5 stall
  gate: boolean;                        // default true
}
export interface OrchestratorConfig {
  enabled: boolean;
  agent: AgentBinding;                  // default claude/sonnet/auto
  gateTimeoutSec: number;               // default 300 → fallback advance degraded:true
}
export interface WorkflowDef {
  schemaVersion: 1;
  id: string; name: string; description: string;
  builtin?: boolean;
  orchestrator: OrchestratorConfig;
  stages: Stage[];                      // linear v1
  maxParallel: number;                  // default 4
  maxRetriesPerStage: number;           // default 2
}
```

### 3.3 Run state

```ts
// shared/src/run.ts
export type NodeRunStatus = 'queued'|'running'|'stalled'|'done'|'failed'|'killed';
// terminal statuses = done | failed | killed  (exported as TERMINAL_NODE_STATUSES)
export type RunStatus = 'created'|'running'|'gating'|'done'|'failed'|'aborted';

export interface NodeRun {
  nodeRunId: string;         // `${stageId}.${slotId}.${instanceIndex}` — 0-based, IMMUTABLE across retries.
                             // Reserved: 'orchestrator'. No provider names in ids.
  stageId: string | null;    // null only for the orchestrator node
  slotId: string; instanceIndex: number;
  agent: AgentBinding; label: string;      // "R2 · grok"
  status: NodeRunStatus;
  attempt: number;           // current attempt, 1-based; retries mutate this NodeRun in place
  cwd: string;
  pid?: number;              // persisted while running (crash sweep, §5.4)
  sessionRef?: string;       // latest provider session/thread id
  startedAt?: number; endedAt?: number;
  usage?: Usage;             // accumulated across attempts (orchestrator: across gates)
  resultText?: string;       // final agent message of latest attempt
  patchFile?: string;        // artifacts/<nodeRunId>.a<attempt>.patch (latest attempt)
  baseCommit?: string;       // worktree base sha (isolation=worktree)
  exitCode?: number | null;
}
export interface GateDecision {
  stageId: string; gateAttempt: number;      // Nth gate evaluation for this stage (1-based)
  action: 'advance'|'retry'|'abort';
  retryNodeRunIds?: string[];                // validated against the stage's real nodes; invalid ids dropped
  promptAddendum?: string;
  contextForNext?: string;
  rationale: string;
  raw?: string;
  degraded?: boolean;                        // parse-failure or gate-timeout fallback
  ts: number;
}
export interface RunSnapshot {
  runId: string; workspaceId: string;
  workflow: WorkflowDef;                     // FROZEN resolved copy — the only workflow source at runtime
  task: string; status: RunStatus;
  currentStageId?: string;
  nodes: NodeRun[];                          // includes the reserved orchestrator NodeRun when enabled
  gateDecisions: GateDecision[];
  createdAt: number; endedAt?: number;
}
```

### 3.4 Workspace & API payloads

```ts
export interface Workspace {
  id: string; name: string; path: string;
  isGit: boolean;                            // computed server-side at create, refreshed on read
  defaultWorkflowId?: string;
  lastRun?: { runId: string; workflowName: string; status: RunStatus; at: number };
}
// shared/src/api.ts (all zod-validated)
export interface RunCreateRequest {
  workspaceId: string;
  workflowId: string;                        // provenance only
  task: string;
  workflowOverride?: WorkflowDef;            // COMPLETE snapshot; executed as-is when present.
}                                            // UI edits builtins ephemerally and submits here.
export interface RetryStageRequest { promptAddendum?: string }
export interface ApplyPatchResponse { ok: boolean; conflicts?: string[]; message: string }
export type WsClientMsg = { type:'sub'|'unsub'; runId: string };
export type WsServerMsg =
  | { type:'event'; event: AgentEvent }
  | { type:'run'; run: RunSnapshot }
  | { type:'workspaces' };                   // rail invalidation ping
```

## 4. Provider adapters (server/src/adapters)

### 4.0 Adapter contract (normative)

```ts
export interface ResolvedNodeSpec {          // built by nodeRunner; the ONLY spawn input
  binding: AgentBinding; promptText: string; cwd: string;
  resumeSessionRef?: string;                 // orchestrator only in v1
}
export interface NodeOutcome {
  exitCode: number | null; signal?: string;
  sessionRef?: string; usage?: Usage;        // camelCase; adapters convert CLI casing
  resultText?: string;                       // accumulated by the adapter during streaming
  error?: string;
}
export interface SpawnedNode { pid: number; kill(sig?: NodeJS.Signals): void; completion: Promise<NodeOutcome> }
export interface Adapter {
  id: ProviderId; tier: 'rich' | 'plain';
  available(): Promise<{ ok: boolean; version?: string; detail?: string }>;
  spawn(spec: ResolvedNodeSpec, io: { onEvent(e: AdapterContentEvent): void;
                                      onRaw(line: string, stream: 'out'|'err'): void }): SpawnedNode;
  models: string[]; defaultModel: string;
}
```

- Adapters accumulate agent text internally; `NodeOutcome.resultText` = final agent message (never assume the CLI's terminal event carries it).
- Prompt delivery (ARG_MAX safety): claude & codex via **stdin**; grok via `--prompt-file`; agy via argv (cap 200 KB, else error event).
- Binary resolution: `registry.ts` maps provider → binary name on PATH. No executable overrides in v1.

### 4.1 claude (rich) — verified 2026-07-18, claude-code 2.1.214 (fixtures: claude.jsonl, claude-tool.jsonl)

```
<prompt on stdin> claude -p --output-format stream-json --verbose \
  [--model M] [--permission-mode PM] [--max-turns N] [--resume SESSION_ID]
```
- `--verbose` REQUIRED with `-p` stream-json.
- Mapping: `system/init` → capture sessionRef; `assistant.message.content[]`: `text`→agent/message, `thinking`→thinking/thinking, `tool_use`→tool/tool_use (toolCallId=id, input JSON-stringified, 4 KB truncate); `user.message.content[].tool_result`→tool/tool_result (toolCallId=tool_use_id, 4 KB truncate); `result`→outcome {exitCode 0, usage {inputTokens:usage.input_tokens, outputTokens:usage.output_tokens, costUsd:total_cost_usd}, resultText: result ?? accumulated}. Skip `rate_limit_event`, `system/*` others (raw log only).
- effort: not mapped v1. Resume: `--resume <sessionRef>` + new prompt on stdin.

### 4.2 codex (rich) — verified, codex-cli 0.144.0 (fixtures: codex.jsonl, codex-tool.jsonl, codex.dirty.jsonl)

```
codex exec --json -m gpt-5.6-sol [-c model_reasoning_effort=E] --cd <CWD> \
  --sandbox <MODE> --skip-git-repo-check -      (prompt on stdin via '-'; never leave stdin open)
```
- Mapping: `thread.started`→sessionRef=thread_id; `item.started {item.type:'command_execution'}`→tool/tool_use (toolCallId=item.id, name 'shell', input=command); `item.completed {command_execution}`→tool/tool_result (output=aggregated_output, isError=exit_code≠0); `item.completed {agent_message}`→agent/message (resultText=last); `item.*` reasoning→thinking; unknown item types→tool rows named by item.type; `turn.completed`→usage {inputTokens, outputTokens}; `turn.failed`/`error`→error.
- `--skip-git-repo-check` always (non-git workspaces are supported).
- effort map low|medium|high|xhigh → `-c model_reasoning_effort=<v>`.
- Resume (orchestrator only): `codex exec resume <thread_id> --json -m <same> -c model_reasoning_effort=<same> --cd <same> --sandbox <same> --skip-git-repo-check -` — ALL flags re-passed explicitly.

### 4.3 grok (rich) — verified, Grok Build TUI headless (fixtures: grok.jsonl, grok-tool.jsonl)

```
grok -p --prompt-file <FILE> --output-format streaming-json [-m grok-4.5] \
  [--reasoning-effort E] --cwd <CWD> [--permission-mode PM] [--max-turns N]
```
- **Probe-confirmed reality: streaming-json emits ONLY `thought`/`text`/`end` events.** Tool calls execute silently between thought tokens — there are NO tool events in v1; grok nodes show no tool rows and the digest reports tool-count "n/a" for grok. Unknown event types, if they ever appear, → tool rows named by type (forward-compat).
- `thought` deltas → coalesce → thinking; `text` deltas → coalesce → agent/message (resultText = full text); `end` → outcome {exitCode 0, sessionRef=sessionId}. Silent gaps during tools are expected — see §5 stall.
- Resume (orchestrator only): `grok -r <sessionRef> -p --prompt-file <FILE> --output-format streaming-json` + same flags.
- Orchestrator-as-grok bonus: pass `--json-schema` for hard decision enforcement.

### 4.4 agy (plain) — verified; Antigravity CLI, no JSON mode (fixture: agy.log)

```
agy -p "<PROMPT>" --model "Gemini 3.1 Pro (High)" [--print-timeout 45m] [--dangerously-skip-permissions]
```
- **Streams stdout incrementally**: chunks coalesce (§3.1 rule 5) into agent/message events as they arrive (liveness); resultText = full accumulated stdout; non-zero exit → error event with stderr tail.
- Model catalog (from CLI): `Gemini 3.5 Flash (Medium|High|Low)`, `Gemini 3.1 Pro (Low|High)`, `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)`. effort picks the matching (High|Low) display-name variant when the base model matches; else ignored.
- No resume v1. Default stall floor 600 s (§5).

### 4.5 Permission tier mapping (implementer: verify each flag against `--help`; nearest safe equivalent + comment if absent)

| tier | claude | codex | grok | agy |
|------|--------|-------|------|-----|
| safe | `--permission-mode plan` | `--sandbox read-only` | `--permission-mode plan` | (prompt-level read-only instruction) |
| auto (default) | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--permission-mode acceptEdits` | — |
| full | `--dangerously-skip-permissions` | `--sandbox danger-full-access` | `--permission-mode bypassPermissions` | `--dangerously-skip-permissions` |

### 4.6 spawn.ts — process hygiene

- env: inherit minus `LD_LIBRARY_PATH` (BAT AppImage breaks child TLS); ensure PATH includes `~/.local/bin`, `/usr/local/bin`.
- `stdio: ['pipe'|'ignore','pipe','pipe']` per adapter (stdin pipe only to write the prompt, then end()).
- **Process groups**: spawn `detached: true`; kill via `process.kill(-pid, sig)`; SIGTERM → SIGKILL escalation after 10 s. Never parent-only kills (CLIs spawn shells/compilers).
- Incremental line buffer (partial lines, multi-line chunks, CRLF).
- Per-attempt hard timeout (stage.timeoutSec) → group-kill + `failed` (detail 'timeout').

### 4.7 mock (rich)

Deterministic scripted adapter for tests/demo. Model string programs it: `ok` (thinking→tool_use→tool_result→message→result), `fail` (error + exit 1), `slow:<ms>` (delays between events), `noisy` (many coalescable chunks). **Echo mode (all models)**: if `promptText` contains the marker `MOCK_REPLY:`, the final agent message text is everything after the marker — this lets engine tests script orchestrator decisions through prompt templates. Used by engine/API tests and `--demo`.

## 5. Workflow engine (server/src/engine)

```
created → running(stage k) → [join: ALL nodes in TERMINAL_NODE_STATUSES] → gating(k) → decision:
  advance → running(k+1) | done (last stage)
  retry   → running(k, only validated retryNodeRunIds; attempt+1; addendum)   [gate evaluations per stage ≤ 1+maxRetriesPerStage, then forced advance degraded]
  abort   → aborted
user abort at any time → group-SIGTERM all live nodes → aborted.
Node failure ≠ run failure (gate decides). All nodes of a stage failed AND orchestrator disabled → run failed.
```

- Concurrency: ≤ `workflow.maxParallel` node processes per run; FIFO queue.
- **Stall**: timer driven by RAW activity (`onRaw` lines OR content events — whichever last). No activity for `effectiveStallSec` → one-shot `status:stalled` event + badge; any subsequent activity → `status:running` (detail 'recovered') and the timer re-arms. `effectiveStallSec = max(stage.stallSec, adapter floor)` — floors: agy 600 s, others stage value. Stalled is non-terminal and never blocks joins.
- **Retry semantics (normative)**: candidates NEVER resume sessions — each retry = fresh spawn, full template re-render with `{{retry_addendum}}`; same NodeRun mutated (attempt+1, status queued, timers reset); engine emits `status:retry {attempt}` boundary event; per-attempt raw logs/patches/worktrees (keys include `.a<attempt>`).
- **Worktrees** (`stage.isolation==='worktree'`): requires `workspace.isGit` (else warning event + fallback none). If the workspace repo is dirty → warning event (agents branch from HEAD; user WIP is invisible to them) but proceed. Per attempt:
  1. Remove leftovers: `git worktree remove --force <dir>` + `git branch -D <branch>` if they exist (retry safety — worktree add crashes otherwise).
  2. `git worktree add <dataDir>/runs/<runId>/wt/<nodeRunId>.a<attempt> -b mat/<runId>/<nodeRunId>-a<attempt> HEAD`; record `baseCommit = rev-parse HEAD`.
  3. On node end: `git -C <wt> add -A && git -C <wt> diff --cached --binary <baseCommit>` → `artifacts/<nodeRunId>.a<attempt>.patch` (+ diffstat into NodeRun). `add -A` is mandatory — plain diff misses untracked files.
  4. Prune all run worktrees+branches on run delete and via "Clean worktrees".
- **Artifact handoff**: next-stage templates receive `{{patches}}` (concatenated patch text, per-patch header `--- patch <nodeRunId> (<label>) ---`, total cap 30 000 chars with truncation markers) and `{{artifact_paths}}` (absolute paths, one per line). Presets use them (§10).

### 5.1 Fan-in digest (deterministic budget)

Per candidate: label, provider/model, status, attempt, duration, usage, tool-call count (grok: "n/a"), diffstat, last error, then resultText. Budget: `perCandidate = clamp(floor(24000 / N), 800, 6000)` chars of resultText (tail-truncated with `…[truncated]`); candidates in slot/instance order; tool detail dropped before resultText. N ≤ 12 by §3.2 stage cap.

### 5.4 Crash recovery & shutdown

- run.json persists `pid` per live node. On server boot: any run with non-terminal status → best-effort `process.kill(-pid)` of recorded pids, prune its worktrees, mark run `aborted` + system event `status {detail:'server-restart'}`; nodes left `running` → `killed`.
- SIGTERM/SIGINT handler: group-kill all live children before exit.
- `DELETE /api/runs/:id` on a non-terminal run → 409 (abort first).

## 6. Orchestrator (server/src/orchestrator)

- Represented as a reserved NodeRun `{nodeRunId:'orchestrator', stageId:null, slotId:'orchestrator', instanceIndex:0}` present in `RunSnapshot.nodes` whenever enabled — it gets a normal node card, stream, status, accumulated usage. Its events carry `stageId:null`, current `attempt` = gate evaluation count.
- Spawned headless **per gate**; claude/codex/grok orchestrators resume their session across gates (full flag re-pass, §4); agy or resume-failure → fresh spawn with full brief re-injection.
- Gate flow: engine builds digest (§5.1) → orchestrator prompt (prompts.ts): role brief, goal, stage results, THEN "reply with reasoning, then a fenced ```json block matching:"

```json
{ "action": "advance|retry|abort", "retryNodeRunIds": ["roundtable.r2.0"],
  "promptAddendum": "…", "contextForNext": "…", "rationale": "one paragraph" }
```

- decision.ts: extract LAST fenced json block → zod parse. Failure → one re-ask ("reply with ONLY the json block"); second failure → `advance, degraded:true` + warning. `retryNodeRunIds` validated against the stage's actual nodes; invalid ids dropped; empty after validation → advance degraded. Gate wall-clock > `gateTimeoutSec` → kill orchestrator attempt, `advance, degraded:true`.
- `enabled:false` ⇒ auto-advance every gate.

### 6.2 Prompt templates

Mustache-lite `{{var}}` (engine-implemented, no dep; unknown vars → empty): `{{task}} {{workspace_name}} {{workspace_path}} {{stage_name}} {{slot_label}} {{instance_index}} {{prior_stage_digest}} {{orchestrator_context}} {{retry_addendum}} {{patches}} {{artifact_paths}}`.

## 7. Persistence — `<dataDir>` default `~/.multi-ai-terminal` (override `--data-dir` / `MAT_DATA_DIR`)

```
workspaces.json                          workflows/<id>.json (custom only)
runs/<runId>/run.json                    # RunSnapshot, atomic tmp+rename on every change
runs/<runId>/events.jsonl                # single-writer append; seq recovered from last line on boot
runs/<runId>/raw/<nodeRunId>.a<N>.jsonl  runs/<runId>/artifacts/*.patch   runs/<runId>/wt/…
settings.json
```

Durability: `events.jsonl` appends via the per-run queue (§3.1 rule 4); no per-line fsync (documented). Retention: keep last 100 runs per workspace, prune oldest (dir + worktrees + branches).

## 8. HTTP / WS API

REST (zod-validated; errors `{error:{code,message}}`; bearer token if configured):

```
GET  /api/health                              → {ok, version}
GET  /api/providers                           → [{id, tier, ok, version, models, defaultModel}]
GET|POST|PATCH|DELETE /api/workspaces(:id)    # POST validates path exists; returns isGit
GET  /api/workflows                           → builtin + custom
POST /api/workflows  PATCH|DELETE /api/workflows/:id    (builtin → 409; POST /api/workflows/:id/duplicate)
POST /api/runs                                RunCreateRequest → RunSnapshot (auto-starts)
GET  /api/runs?workspaceId=&limit=50&before=<createdAt>   → RunSnapshot[] (newest first, cursor = createdAt)
GET  /api/runs/:id                            → RunSnapshot
GET  /api/runs/:id/events?afterSeq=0&limit=1000 → AgentEvent[]
GET  /api/runs/:id/patches/:nodeRunId         → text/plain latest-attempt patch content
POST /api/runs/:id/abort
POST /api/runs/:id/nodes/:nodeRunId/kill
POST /api/runs/:id/stages/:stageId/retry      RetryStageRequest — valid while gating at that stage, or when the
                                              run is terminal and stageId was the last executed stage (run re-enters running(k));
                                              counts against the stage's gate budget
POST /api/runs/:id/nodes/:nodeRunId/apply-patch → ApplyPatchResponse   # git apply --3way --binary in workspace;
                                              NO dirty-workspace refusal (sequential candidate patches must stack);
                                              conflicts reported, partial application rolled back (apply --check first)
DELETE /api/runs/:id                          # 409 if non-terminal
```

WS `/ws[?token=]`: client `{type:'sub'|'unsub', runId}`; server pushes per §3.4 `WsServerMsg`. Broadcast strictly after durable append. Heartbeat 30 s; client reconnect = resub + REST `afterSeq` catch-up (no gaps: seq is the cursor).

## 9. Frontend spec (web/)

Four-column CSS grid (Ted's mock), draggable dividers, dark theme default.

1. **Workspace rail**: cards — name, short path, `lastRun` badge ("Planning · done · 2h ago"), live pulse when running; add-workspace dialog (server validates; shows isGit chip).
2. **Workflow panel**: workflow dropdown (builtin ⭐ + custom). Stage sections with slot chips (`AgentChip`: provider color dot + provider + model + effort + ×count). Chip popover: model input w/ datalist, effort select, count stepper (1–8), permission select, promptTemplate textarea, remove. Stage header: isolation toggle, timeout, gate toggle. **Agent palette at the bottom** (draggable chips per provider; grayed when unavailable); drag onto a stage appends a slot (provider defaults); "+ add agent" menu as fallback. **Editing a builtin mutates an ephemeral run-scoped copy** submitted as `workflowOverride` — banner offers "Duplicate to save". **Run box**: task textarea, orchestrator toggle + binding summary, Start (disabled while a run is active in this workspace).
3. **Run panel**: stage groups; node cards: label, provider ring, status badge (queued gray / running sky / thinking pulse / stalled amber / done emerald / failed red / killed zinc), elapsed ticker, last-event line, usage/cost, buttons: kill, view patch (modal, content from `/patches/:nodeRunId`, Apply patch inside), focus-stream. Orchestrator card pinned top. Gate decision cards (emerald; amber border when degraded) between stages; stage header retry button (calls retry-stage).
4. **Stream panel**: virtualized aggregated feed (`@tanstack/react-virtual`). EventRow merges consecutive same-(node,attempt,kind) events (§3.1 rule 5). Styling: user sky left-border; agent ink; thinking violet italic collapsed 2 lines; tool amber mono (tool_use header + collapsible result, matched by toolCallId); decision emerald card; error red; status dim. Filters: node multi-select, category toggles, auto-follow (pause on scroll-up), client-side search. Header: run selector (live + history via cursor paging) — replay uses the same renderer fed by REST pages.
5. **Theme tokens**: `--panel #18181b --border #27272a --ink #e4e4e7 --muted #a1a1aa` accent `#a78bfa`; providers: claude `#d97706`, codex `#10a37f`, agy `#4285f4`, grok `#e11d48`, mock `#71717a`.
6. **zustand store (FROZEN wave 0)**: state {workspaces, workflows, providers, selectedWorkspaceId, ephemeralWorkflowEdits, activeRunId, runs: Record<runId,RunSnapshot>, events: Record<runId,AgentEvent[]> (ring 20k), filters {nodeRunIds, roles, follow}, ui {focusedNodeRunId}} + actions (setters, applyWsMsg(msg), focusNode(id), toggleRole(role), loadOlderEvents(runId)). Wave-1 panels consume via selectors; gaps reported, not hacked in.

## 10. Builtin presets (shared/src/presets) — also the reference examples for §6.2

1. **planning.json** — Round Table (gate ✓, isolation none): R1 codex/gpt-5.6-sol/high, R2 claude/sonnet, R3 grok/grok-4.5 — independent implementation plans. Final Review: claude/opus, permission safe, template uses `{{prior_stage_digest}}`. Orchestrator claude/sonnet enabled.
2. **build.json** — Implement (isolation worktree, gate ✓): codex/gpt-5.6-sol/high ×2. Review: grok + claude on `{{patches}}`. Orchestrator enabled.
3. **review.json** — Review (permission safe, gate off): claude, codex, grok, agy ×1. Synthesize: claude merges verdicts via `{{prior_stage_digest}}`. Orchestrator disabled.

## 11. Testing & acceptance

- Fixtures: **cleaned real captures vendored by wave-0 from `/tmp/mat-probes/clean/`** → `server/test/fixtures/{claude.jsonl, claude-tool.jsonl, codex.jsonl, codex-tool.jsonl, codex.dirty.jsonl, grok.jsonl, grok-tool.jsonl, agy.log}`. `codex.dirty.jsonl` (stderr banner interleaved) exercises §3.1 rule 6.
- Unit: adapters × fixtures → exact expected event sequences incl. coalescing and outcome fields; line-buffer edges; decision.ts (happy, re-ask, degraded, invalid-id filtering); template rendering; digest budget math; store atomicity + seq recovery.
- Engine (mock adapter): happy 2-stage fan-out 3; retry loop honoring budgets + `status:retry` boundaries + user-event synthesis per attempt; all-fail; abort mid-stage; stall mark+recover; worktree lifecycle incl. retry re-add and untracked-file patch capture (real temp git repo); crash sweep (simulated stale run.json).
- API: fastify inject — full run lifecycle with mock provider, WS order = after-append, afterSeq catch-up, retry-stage validity matrix, apply-patch 3way conflict path, token auth on/off.
- Smoke: `scripts/smoke-real.sh` (opt-in) — real claude(haiku)+codex+grok+agy tiny task through Planning; asserts ≥1 event of each of the four categories incl. synthesized user events + a gate decision.
- **Acceptance**: `npm install && npm run build && npm test` green on Node 24; `npm start` serves UI; §1 story executes with real CLIs; a finished run replays after server restart; crash sweep leaves no orphan processes/worktrees.

## 12. Build-phase module ownership (codex fleet)

| Wave | Worker | Owns (exclusive) |
|------|--------|------------------|
| 0 | scaffold | whole tree; all package/tsconfig/tailwind/vite; shared/src COMPLETE; web/src/components/** COMPLETE; web/src/app/store.ts COMPLETE (frozen); api client/ws; mock adapter COMPLETE; eventLog + dataDir COMPLETE; stubs elsewhere; fixtures vendored; build+test green |
| 1 | W-adapters | server/src/adapters/** (incl. mock.ts — keep wave-0 mock tests green), server/src/spawn.ts, server/test/adapters/** |
| 1 | W-engine | server/src/engine/**, server/src/orchestrator/**, server/test/engine/** |
| 1 | W-store-api | server/src/store/{workspaces,workflows,runs}.ts, server/src/api/**, server/src/index.ts, server/test/api/** |
| 1 | W-web-shell | web/src/panels/workspace/**, web/src/panels/workflow/**, web/src/app/App.tsx + layout (NOT store.ts) |
| 1 | W-web-run | web/src/panels/run/**, web/src/panels/stream/** |
| 2 | integrate | cross-module fixes only |

### 12.1 Internal seams (wave-0 stubs implement these signatures verbatim)

- `store/eventLog.appendEvent(runId, partial: Omit<AgentEvent,'id'|'seq'|'ts'>): AgentEvent` — sync assign+append, THEN caller-visible; wsHub subscribes to appends (never broadcasts unappended events).
- `engine/runManager`: `createRun(req: RunCreateRequest): Promise<RunSnapshot>`, `abortRun(runId)`, `killNode(runId, nodeRunId)`, `retryStage(runId, stageId, req)`, `applyPatch(runId, nodeRunId)`, `sweepOnBoot()` — the complete surface routes.ts consumes.
- Adapter contract exactly §4.0; nodeRunner is the only event stamper; store.runs persists RunSnapshot atomically.
- Wave-1 workers MUST NOT edit shared/src/**, web/src/components/**, web/src/app/store.ts, package.json, or another worker's files. Contract gaps → report back; fixed centrally between waves.
