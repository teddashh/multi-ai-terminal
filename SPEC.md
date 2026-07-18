# Multi-AI Terminal — Product & Engineering Spec (v1.0)

> Status: draft for 4-model panel review (Fable 5 author; codex gpt-5.6-sol, agy Gemini 3.1 Pro, grok 4.5 reviewers)
> Date: 2026-07-18

## 0. What this is

**Multi-AI Terminal (MAT)** is a workflow-orchestration workbench for **CLI coding agents** (claude, codex, grok, agy/gemini). The user composes a workflow (e.g. *Planning Mode*: Orchestrator → Round-Table candidates → Final Reviewer), drags agents onto workflow checkpoints, and watches every agent's live, categorized message stream (**your / agent / tool / thinking**) side by side, while a real LLM orchestrator monitors the run and decides advance/retry at each gate.

This is the successor concept to `multi-ai-chat-desktop` (webchat orchestration) rebuilt on the CLI/agent-SDK path. It is **not** a terminal emulator and **not** a fork of better-agent-terminal.

### Decisions locked by the 12-round design debate (do not relitigate)

1. **Do not reuse multi-ai-chat-desktop's runtime** (webview automation). Borrow only UI mental model + design tokens.
2. **Single primary data stream = headless JSONL.** Every workflow node runs its CLI in non-interactive structured-output mode. No interactive PTY, no ANSI parsing, no xterm.js in v1.
3. **Per-provider adapters normalize JSONL to one internal event schema.** Hard-coded mappings per CLI, no speculative abstract parser framework. CLIs without JSON output (agy) degrade to a "plain" tier: whole stdout = one agent message.
4. **Presentation layer is a styled message panel** (React list, four categories + status), visually inspired by better-agent-terminal's agent panels. This is the product's differentiation and is written from scratch.
5. **Orchestrator = a real LLM agent, minimum-branch.** The workflow trunk is deterministic (fan-out stage → join → gate → next stage). The LLM decides only at gates: advance / retry(which nodes, with what added context) / abort, and must emit a machine-parseable decision + human-readable rationale (decision log is first-class UI data).
6. **Turn-based coordination via job queue + files.** No realtime stdin injection, no terminal multiplexer. Fan-in compares normalized events/artifacts.
7. **Node schema is provider-agnostic from day 1**: `provider + command + model + effort + cwd/worktree + parserTier`. Multiple instances of the same agent at one checkpoint (e.g. 4× gemini) is a core interaction.
8. **Mid-run human intervention is out of scope for v1** except: kill node, retry stage, abort run, and (safe) apply-patch. No typing into a live agent session.

### Non-goals (v1)

- Interactive terminals / attaching to agent stdin.
- Dynamic runtime graph growth (orchestrator spawning brand-new node types mid-run). Retries of existing nodes only.
- Tauri/Electron packaging (v1 ships as a localhost web app; see §2 rationale). Windows support.
- Graph-canvas editing. Editing is **form-based** (stage list + slot chips); drag-and-drop assigns agents to stages.
- i18n (English UI; zh-TW later).

## 1. Primary user story

Ted opens MAT on castle1 via browser (Tailscale). Left rail shows workspaces (repos) with the last workflow mode each ran. He picks workspace `bat-fleet-kit`, selects **Planning Mode**, drags `codex` and two `grok` chips onto *Round Table*, sets one candidate's model/effort, types the task, hits **Run**. Node cards light up; the right panel streams every agent's your/agent/tool/thinking messages live. At the gate, the Orchestrator's decision card explains why R2 gets retried with extra context. The Final Reviewer produces the consolidated plan; the full run is replayable afterwards.

## 2. Architecture & stack

**Topology: single Node.js server process + browser UI** (like `bat-server` mode Ted already uses on castle1, but natively headless — no xvfb).

- Server: **Node ≥ 20, TypeScript, Fastify** (REST + WebSocket + static hosting of the built web app). Spawns agent CLIs as child processes (`child_process.spawn`, stdin = `/dev/null`+`'ignore'`), parses stdout JSONL line-by-line, persists + broadcasts normalized events.
- Frontend: **React 18 + Vite + TypeScript + Tailwind CSS + zustand + @dnd-kit/core**. Talks to the server ONLY through `web/src/api/client.ts` (REST) and `web/src/api/ws.ts` (WS) — the "host seam" pattern proven in multi-ai-chat-desktop.
- Shared package: **zod schemas + TS types** consumed by both sides.
- Monorepo: npm workspaces (`shared/`, `server/`, `web/`). Node 24 available on target machine; engines `>=20`.

Why web-served instead of Tauri (references are all Tauri): Ted's fleet machines are headless servers accessed over Tailscale; BAT requires an xvfb hack there today. A localhost web app is natively headless, verifiable end-to-end in CI/agents, and can be wrapped in Tauri later without changing the server↔UI contract.

### Repo layout

```
multi-ai-terminal/
├── package.json                # npm workspaces root; scripts: dev, build, test, start
├── SPEC.md  README.md  LICENSE (MIT)
├── shared/
│   └── src/
│       ├── events.ts           # AgentEvent + zod schema
│       ├── workflow.ts         # WorkflowDef/Stage/Slot/AgentBinding + zod
│       ├── run.ts              # RunSnapshot/NodeRun/statuses + zod
│       ├── providers.ts        # ProviderId, ProviderInfo, model catalogs, permission tiers
│       ├── api.ts              # REST/WS payload types
│       └── presets/            # planning.json build.json review.json (builtin workflows)
├── server/
│   └── src/
│       ├── index.ts            # CLI entry: mat-server [--port 7788] [--data-dir ~/.multi-ai-terminal]
│       ├── spawn.ts            # sanitized env spawn util (see §4.6)
│       ├── adapters/           # base.ts claude.ts codex.ts grok.ts agy.ts gemini.ts mock.ts registry.ts
│       ├── engine/             # runManager.ts stageRunner.ts nodeRunner.ts joins, retries, stall, worktree.ts
│       ├── orchestrator/       # digest.ts decision.ts prompts.ts
│       ├── store/              # dataDir.ts workspaces.ts workflows.ts runs.ts eventLog.ts
│       └── api/                # routes.ts wsHub.ts
│   └── test/                   # vitest; fixtures/ = REAL captured CLI outputs
└── web/
    └── src/
        ├── app/                # App shell, layout grid, theme, store.ts (zustand)
        ├── api/                # client.ts ws.ts (only backend touchpoints)
        ├── panels/workspace/   # left rail
        ├── panels/workflow/    # mode picker, stage editor, agent palette (drag source), run box
        ├── panels/run/         # node cards grid
        ├── panels/stream/      # aggregated feed, filters, replay
        └── components/         # EventRow, AgentChip, StatusDot, Collapsible, ModalDialog…
```

## 3. Shared contracts (normative)

### 3.1 Normalized event schema — the spine of the product

```ts
// shared/src/events.ts
export type EventRole = 'user' | 'agent' | 'tool' | 'thinking' | 'system' | 'decision';
export type EventKind =
  | 'message'        // user prompt or agent text
  | 'thinking'       // reasoning stream (may be chunk-merged)
  | 'tool_use'       // tool invocation {name, input}
  | 'tool_result'    // tool output {name, output, isError}
  | 'status'         // lifecycle: spawned|running|stalled|killed|done|failed + detail
  | 'decision'       // orchestrator gate decision (payload = GateDecision)
  | 'error'          // adapter/process error
  | 'result';        // terminal summary (exit code, usage, cost, sessionRef)

export interface AgentEvent {
  id: string;            // nanoid
  seq: number;           // monotonic per run (assigned by event log)
  runId: string;
  stageId: string | null;    // null for run-level/system events
  nodeRunId: string | null;  // instance id, e.g. "roundtable.grok.2"; null for run-level
  role: EventRole;
  kind: EventKind;
  text: string;              // human-readable body (may be '')
  tool?: { name: string; input?: string; output?: string; isError?: boolean };
  data?: Record<string, unknown>;  // kind-specific payload (GateDecision, usage, exit info)
  ts: number;                // epoch ms
}
```

Rules:
- Adapters MUST emit `status:spawned` → (`thinking|message|tool_*`)* → `result` (or `error`) per node run.
- Token-delta streams (grok) are **coalesced per event type** and flushed on type-change or ≥500 ms — the store must not receive one event per token. UI receives the same coalesced granularity.
- Every raw stdout/stderr line is also appended verbatim to `raw/<nodeRunId>.jsonl` for debugging/replay-of-record. Normalized events reference nothing in raw (no raw_ref needed in v1).

### 3.2 Workflow definition

```ts
// shared/src/workflow.ts
export interface AgentBinding {
  provider: 'claude' | 'codex' | 'grok' | 'agy' | 'gemini' | 'mock';
  model?: string;            // free text; UI offers per-provider suggestions
  effort?: 'low' | 'medium' | 'high' | 'xhigh';  // mapped per provider; ignored where N/A
  permission: 'safe' | 'auto' | 'full';          // §4.5 mapping table
  systemPromptAppend?: string;
  maxTurns?: number;
}
export interface Slot {
  id: string;                // stable within stage
  label: string;             // "R1", "Final Reviewer"
  agent: AgentBinding;
  count: number;             // fan-out instances (1..8)
  promptTemplate: string;    // §6.2 template vars
}
export interface Stage {
  id: string; name: string;
  slots: Slot[];
  isolation: 'none' | 'worktree';
  join: 'all';               // v1 only
  timeoutSec: number;        // default 1800
  stallSec: number;          // default 120 (no events → stalled badge)
  gate: boolean;             // run orchestrator decision after join (default true)
}
export interface OrchestratorConfig {
  enabled: boolean;          // false ⇒ deterministic advance at every gate
  agent: AgentBinding;       // default: claude / sonnet / auto
  briefTemplate?: string;
}
export interface WorkflowDef {
  schemaVersion: 1;
  id: string; name: string; description: string;
  builtin?: boolean;         // builtin defs are immutable; "duplicate to customize"
  orchestrator: OrchestratorConfig;
  stages: Stage[];           // linear v1; graph edges later
  maxParallel: number;       // default 4
  maxRetriesPerStage: number; // default 2
}
```

### 3.3 Run state

```ts
// shared/src/run.ts
export type NodeRunStatus = 'queued'|'running'|'stalled'|'done'|'failed'|'killed';
export type RunStatus     = 'created'|'running'|'gating'|'done'|'failed'|'aborted';
export interface NodeRun {
  nodeRunId: string;         // `${stageId}.${slotId}.${i}`
  stageId: string; slotId: string; instanceIndex: number;
  agent: AgentBinding; label: string;   // "R2 · grok"
  status: NodeRunStatus;
  attempt: number;                       // 1 + retries consumed
  cwd: string;                           // workspace path or worktree path
  sessionRef?: string;                   // provider session/thread id (resume)
  startedAt?: number; endedAt?: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  resultText?: string;                   // final agent message (fan-in convenience)
  patchFile?: string;                    // artifacts/<nodeRunId>.patch when isolation=worktree
  exitCode?: number;
}
export interface RunSnapshot {
  runId: string; workspaceId: string; workflowId: string; workflowName: string;
  task: string; status: RunStatus;
  currentStageId?: string;
  nodes: NodeRun[];
  gateDecisions: GateDecision[];
  createdAt: number; endedAt?: number;
}
export interface GateDecision {
  stageId: string; attempt: number;
  action: 'advance'|'retry'|'abort';
  retryNodeRunIds?: string[];
  promptAddendum?: string;       // injected into retried nodes
  contextForNext?: string;       // injected into next stage's {{orchestrator_context}}
  rationale: string;             // shown in decision card
  raw?: string;                  // orchestrator's full reply
  degraded?: boolean;            // true if parse failed and fallback applied
  ts: number;
}
```

### 3.4 Workspace

```ts
export interface Workspace {
  id: string; name: string; path: string;          // absolute repo/project dir
  defaultWorkflowId?: string;
  lastRun?: { runId: string; workflowName: string; status: RunStatus; at: number };
}
```

## 4. Provider adapters (server/src/adapters)

### 4.0 Adapter contract

```ts
export interface AdapterSpawnArgs {
  prompt: string; cwd: string; binding: AgentBinding;
  resumeSessionRef?: string;
  onEvent(e: Omit<AgentEvent,'id'|'seq'|'runId'|'stageId'|'nodeRunId'|'ts'>): void;
  onRaw(line: string, stream: 'stdout'|'stderr'): void;
}
export interface Adapter {
  id: ProviderId;
  tier: 'rich' | 'plain';
  available(): Promise<{ ok: boolean; version?: string; detail?: string }>;
  spawn(args: AdapterSpawnArgs): SpawnedNode;  // { pid, kill(signal), completion: Promise<NodeOutcome> }
  models: string[];            // suggestions only, free-text allowed
}
```

All spawns go through `spawn.ts` (§4.6). One retry on immediate spawn failure (ENOENT → status error "CLI not found").

### 4.1 claude (tier: rich) — verified 2026-07-18 on claude-code 2.1.214

```
claude -p <PROMPT> --output-format stream-json --verbose \
  [--model M] [--permission-mode PM] [--max-turns N] [--resume SESSION_ID]
```
- `--verbose` is REQUIRED for stream-json with `-p`.
- Events observed (fixtures in `server/test/fixtures/claude.jsonl`):
  - `{"type":"system","subtype":"init","session_id","model",…}` → capture `sessionRef=session_id`; emit status running.
  - `{"type":"assistant","message":{"content":[{"type":"text"|"thinking"|"tool_use",…}]}}` → map content blocks: text→agent/message, thinking→thinking/thinking, tool_use→tool/tool_use (input JSON-stringified, truncated 4 KB).
  - `{"type":"user","message":{"content":[{"type":"tool_result",…}]}}` → tool/tool_result (truncate 4 KB).
  - `{"type":"result","subtype":"success"|…, "result", "total_cost_usd","usage",…}` → result event with usage {input_tokens, output_tokens, costUsd=total_cost_usd}; resultText=result.
  - Ignore: `rate_limit_event`, `system/thinking_tokens`, other system subtypes (still land in raw log).
- effort: NOT mapped in v1 (no stable CLI flag); model encodes capability.
- Resume: `--resume <sessionRef> -p <newPrompt> --output-format stream-json --verbose`.

### 4.2 codex (tier: rich) — verified on codex-cli 0.144.0

```
codex exec --json -m gpt-5.6-sol [-c model_reasoning_effort=EFFORT] \
  [--cd CWD] [--sandbox MODE] <PROMPT>     (stdin: /dev/null — else it reads stdin)
```
- Events observed (`fixtures/codex.jsonl`):
  - `{"type":"thread.started","thread_id"}` → sessionRef=thread_id; status running.
  - `{"type":"turn.started"}` ignore.
  - `{"type":"item.completed","item":{"type":"agent_message","text"}}` → agent/message; resultText=last agent_message.
  - `item.*` with item.type `reasoning` → thinking; `command_execution` → tool (name="shell", input=command, output=aggregated_output, isError=exit_code≠0); `file_change`/`patch` types → tool "apply_patch"; unknown item types → tool with name=item.type (forward-compatible).
  - `{"type":"turn.completed","usage":{input_tokens,output_tokens}}` → result usage.
  - `{"type":"error",…}` → error.
- effort map: low|medium|high|xhigh → `-c model_reasoning_effort=<v>`.
- Resume: `codex exec resume <thread_id> --json <PROMPT>`.

### 4.3 grok (tier: rich) — verified on Grok Build TUI (headless mode)

```
grok -p <PROMPT> --output-format streaming-json [-m grok-4.5] \
  [--reasoning-effort E] [--cwd CWD] [--permission-mode PM] [--max-turns N]
```
- Events observed (`fixtures/grok.jsonl`) — **token deltas, MUST coalesce**:
  - `{"type":"thought","data":"<token>"}`* → coalesce → thinking.
  - `{"type":"text","data":"<chunk>"}`* → coalesce → agent/message; resultText=full coalesced text.
  - tool events (`tool_call`/`tool_result`-like types; verify against live output, map by type name; unknown types → tool row) — implementer: run one tool-using probe and pin mapping in fixtures.
  - `{"type":"end","stopReason","sessionId"}` → result; sessionRef=sessionId.
- Resume: `grok -r <sessionId> -p <PROMPT> --output-format streaming-json`.
- Structured decisions available via `--json-schema` (used by orchestrator when provider=grok).

### 4.4 agy (tier: plain) — verified; Antigravity CLI, no JSON output mode

```
agy -p <PROMPT> --model "Gemini 3.1 Pro (High)" [--print-timeout 45m] [--dangerously-skip-permissions]
```
- Whole stdout (on completion) = one agent/message event; stderr tail included in error on non-zero exit. Emit status running on spawn, result on exit. resultText = stdout.
- Model catalog (from CLI error listing): `Gemini 3.5 Flash (Medium|High|Low)`, `Gemini 3.1 Pro (Low|High)`, `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)`. effort is encoded in the display name — the `effort` field maps High/Low variants when the base name matches, else ignored.
- Resume: not supported v1 (stateless one-shot; `--conversation` exists but ID capture is unreliable headlessly).

### 4.5 Permission tier mapping

| tier | claude | codex | grok | agy |
|------|--------|-------|------|-----|
| safe | `--permission-mode plan` | `--sandbox read-only` | `--permission-mode plan` | (no flag; prompt says read-only) |
| auto (default) | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--permission-mode acceptEdits` | — |
| full | `--dangerously-skip-permissions` | `--sandbox danger-full-access` | `--permission-mode bypassPermissions` | `--dangerously-skip-permissions` |

(Implementer: verify each flag against `--help` at build time; if a flag is absent, nearest safe equivalent + code comment.)

### 4.6 spawn.ts — environment hygiene (castle1 lessons)

- `env`: inherit, then **delete `LD_LIBRARY_PATH`** (BAT AppImage env breaks child curl/git TLS), ensure `PATH` includes `~/.local/bin` and `/usr/local/bin`.
- `stdio: ['ignore','pipe','pipe']`; kill = SIGTERM, escalate SIGKILL after 10 s.
- Line-split stdout with a proper incremental line buffer (handle partial lines / >1 line per chunk).
- Per-node hard timeout (stage.timeoutSec) → kill + status failed (reason timeout).

### 4.7 mock (tier: rich)

Scripted adapter for tests/demo: emits a deterministic event sequence (thinking → tool → message → result) with configurable delay/failure. Used by engine tests and `--demo` mode.

## 5. Workflow engine (server/src/engine)

State machine per run:

```
created → running(stage k) → [join: all nodes terminal] → gating(k) → decision:
   advance → running(stage k+1) | done (last stage)
   retry   → running(stage k, only retryNodeRunIds, attempt+1, prompt+addendum)   [max maxRetriesPerStage, then forced advance with degraded flag]
   abort   → aborted
node failure ≠ run failure: failures are surfaced to the gate; orchestrator decides. If ALL nodes in a stage fail and orchestrator disabled → run failed.
abort (user) at any time → SIGTERM all live nodes → aborted.
```

- Concurrency: at most `maxParallel` node processes per run; excess queue FIFO.
- Stall: no adapter events for `stallSec` → status stalled (badge + event); process not killed.
- **Worktree isolation** (`stage.isolation === 'worktree'`): requires workspace to be a git repo (else warn + fallback none). Per instance: `git worktree add <dataDir>/runs/<runId>/wt/<nodeRunId> -b mat/<runId>/<nodeRunId> HEAD`. On node completion: capture `git diff` (vs stage base) to `artifacts/<nodeRunId>.patch` + diffstat into NodeRun. Worktrees pruned on run deletion (`git worktree remove --force` + branch delete), and a "Clean worktrees" action per run.
- Sequential stages share context via templates (§6.2); files flow as patches, not merges, in v1.

### 5.1 Fan-in digest (engine → orchestrator, and stage k → k+1 templates)

Per candidate: label, provider/model, status, attempt, duration, usage; **final message (resultText) in full up to 6 000 chars** (tail-truncated with marker); tool-call count + last error; diffstat if patch exists. Total digest hard-capped at 24 000 chars (drop oldest tool detail first, never truncate rationale-critical resultText below 2 000 chars/candidate).

## 6. Orchestrator (server/src/orchestrator)

- One LLM agent per run (configurable binding; default claude/sonnet/auto). Spawned headless **per gate** with `--resume` continuity when supported: gate 1 creates the session (run brief + stage-1 digest), later gates resume it (delta digest only).
- **Monitoring**: engine-driven. During a stage the orchestrator sleeps; the engine wakes it only at joins (all-terminal) — turn-based by design. Stall/timeout info is included in the gate digest.
- Gate prompt (prompts.ts) instructs: *you are the workflow orchestrator; here is the goal, stage results digest; reply with your reasoning, then a fenced ```json block matching:*

```json
{ "action": "advance|retry|abort",
  "retryNodeRunIds": ["roundtable.grok.2"],
  "promptAddendum": "…",
  "contextForNext": "…",
  "rationale": "one paragraph" }
```

- Parsing (decision.ts): extract last fenced json block → zod-validate. On failure: one re-ask ("reply with ONLY the json block"); on second failure: fallback `advance` with `degraded:true` + warning event. When orchestrator binding is grok, pass `--json-schema` for hard enforcement.
- Decision → `GateDecision`, persisted on run + emitted as `decision` event under nodeRunId `orchestrator` (the orchestrator renders as a node card too, with its own stream).
- `orchestrator.enabled=false` ⇒ every gate auto-advances (deterministic mode).

### 6.2 Prompt templates

Available vars (mustache-lite `{{var}}`, implemented in engine, no dependency): `{{task}}`, `{{workspace_name}}`, `{{workspace_path}}`, `{{stage_name}}`, `{{slot_label}}`, `{{instance_index}}`, `{{prior_stage_digest}}`, `{{orchestrator_context}}`, `{{retry_addendum}}`. Unknown vars render empty. Builtin presets ship sensible templates (candidates get task+context; reviewer gets full prior digest).

## 7. Persistence (server/src/store) — `~/.multi-ai-terminal/`

```
workspaces.json                    # Workspace[]
workflows/<id>.json                # custom WorkflowDef (builtins live in shared/presets, not copied)
runs/<runId>/run.json              # RunSnapshot (rewritten on change, atomic tmp+rename)
runs/<runId>/events.jsonl          # normalized AgentEvent, append-only, seq assigned here
runs/<runId>/raw/<nodeRunId>.jsonl # raw stdout/stderr lines {s:'out'|'err', l:'…', ts}
runs/<runId>/artifacts/*.patch
runs/<runId>/wt/…                  # worktrees (gitignored area, pruned on delete)
settings.json                      # port etc. (v1 minimal)
```

Retention: keep last 100 runs per workspace (config), prune oldest (delete dir + worktrees).

## 8. HTTP / WS API (server/src/api)

REST (JSON; zod-validated; errors `{error:{code,message}}`):

```
GET  /api/health                         → {ok, version}
GET  /api/providers                      → [{id, tier, ok, version, models, defaultModel}]
GET/POST/PATCH/DELETE /api/workspaces(:id)
GET  /api/workflows                      → builtin + custom
POST /api/workflows  PATCH/DELETE /api/workflows/:id   (builtin → 409; use POST /api/workflows/:id/duplicate)
POST /api/runs        {workspaceId, workflowId, task, overrides?} → RunSnapshot (auto-starts)
GET  /api/runs?workspaceId=&limit=       → RunSnapshot[] (no events)
GET  /api/runs/:id                       → RunSnapshot
GET  /api/runs/:id/events?afterSeq=&limit=1000 → AgentEvent[]   (replay paging)
POST /api/runs/:id/abort
POST /api/runs/:id/nodes/:nodeRunId/kill
POST /api/runs/:id/nodes/:nodeRunId/apply-patch   → git apply --3way in workspace; refuses if workspace dirty
DELETE /api/runs/:id
```

WS `/ws` (server→client only, v1): client sends `{type:'sub', runId}` / `{type:'unsub', runId}`; server pushes `{type:'event', event}` (subscribed runs), `{type:'run', run}` on RunSnapshot changes, `{type:'workspaces'}` ping on rail changes. Heartbeat ping/pong 30 s; client reconnects with resubscribe + `afterSeq` REST catch-up (no missed events).

## 9. Frontend spec (web/)

Layout — 4 columns (Ted's mock), CSS grid, resizable via simple drag handles; dark theme default:

```
┌ Workspaces ┬ Workflow ─────┬ Run (node cards) ──┬ Streams ──────────┐
│ rail       │ mode picker   │ stage-grouped grid │ aggregated feed   │
│ last-mode  │ stage editor  │ status/usage/kill  │ filters + replay  │
│ badges     │ run box       │ orchestrator card  │ four categories   │
│            │ agent palette │ gate decision cards│                   │
└────────────┴───────────────┴────────────────────┴───────────────────┘
```

1. **Workspace rail**: workspace cards — name, short path, `lastRun` badge ("Planning · done · 2h ago"), live pulse when running. Add-workspace dialog (name + absolute path; server validates dir exists + is-git flag shown). Select → drives other panels.
2. **Workflow panel**: workflow dropdown (builtin ⭐ + custom); stage list, each stage a section with slot chips (`AgentChip`: provider color dot + provider + model + effort + ×count). Click chip → detail popover form (model text input w/ datalist suggestions from /api/providers, effort select, count stepper, permission select, promptTemplate textarea, remove). Stage header: isolation toggle, timeout, gate on/off. **Agent palette at the bottom**: one draggable chip per available provider (grayed with tooltip when `ok:false`); drag onto a stage → appends a slot (defaults per provider). @dnd-kit; also an explicit "+ add agent" menu per stage (a11y/fallback). Builtin workflow edits prompt "Duplicate to customize". **Run box**: task textarea + Start (disabled while running) + orchestrator toggle + its binding summary.
3. **Run panel**: stages as vertical groups; per NodeRun a card: label, provider ring color, status badge (queued/running/thinking-pulse/stalled amber/done green/failed red/killed gray), elapsed ticker, last event line (1-line), usage/cost when known, buttons: kill (running), view patch (when patchFile) → modal with diff text + Apply patch button, focus-stream. Orchestrator card pinned top with monitor status; gate decisions render as emerald cards between stage groups (rationale + action + degraded warning).
4. **Stream panel**: virtualized list (est. 10k+ events; `@tanstack/react-virtual`). Row per AgentEvent: agent chip (node label, provider color), category style:
   - user → sky left border; agent → default ink; thinking → violet italic, collapsed to 2 lines, click-expand; tool → amber monospace `tool_use` header + collapsible output; decision → emerald card; error/system → red/dim.
   - Filters: node multi-select chips, category toggles, auto-follow switch (pause on scroll-up), search-in-run (client-side).
   - Header: run selector (live run + history list from GET /runs) → selecting a past run streams pages via `afterSeq` REST into the same panel (replay = same renderer).
5. **Theme**: class-based dark default. Tokens (CSS vars, borrowed continuity): `--panel #18181b`, `--border #27272a`, `--ink #e4e4e7`, `--muted #a1a1aa`, accent violet `#a78bfa`; provider colors: claude `#d97706`, codex `#10a37f`, gemini/agy `#4285f4`, grok `#e11d48`, mock `#71717a`. Status: running sky, stalled amber, done emerald, failed red.
6. **State**: one zustand store: {workspaces, workflows, providers, selectedWorkspaceId, activeRun, runsIndex, events by runId (ring buffer 20k, older via REST), filters}. WS handlers dispatch into store; components subscribe by selector.

## 10. Builtin workflow presets (shared/src/presets)

1. **planning.json — Planning Mode**: Stage `roundtable` "Round Table" (gate ✓, isolation none): R1 codex/gpt-5.6-sol/high, R2 claude/sonnet, R3 grok/grok-4.5 — candidates draft independent implementation plans. Stage `review` "Final Review": Reviewer claude/opus (permission safe) consolidates into one plan with risks/decisions. Orchestrator claude/sonnet enabled.
2. **build.json — Build Mode**: Stage `implement` (isolation worktree, gate ✓): Builder codex/gpt-5.6-sol/high ×2 — implement per plan in isolated worktrees. Stage `review`: Reviewer panel grok + claude on the patches. Orchestrator enabled.
3. **review.json — Review Mode**: Stage `review` (permission safe, gate off): claude + codex + grok + agy ×1 each review the repo/diff per task. Stage `synthesize`: claude merges verdicts. Orchestrator disabled.

Templates in these files are the reference examples for §6.2.

## 11. Testing & acceptance

- **Unit (vitest)**: each adapter parses its checked-in REAL fixture (claude.jsonl / codex.jsonl / grok.jsonl / agy.log from live probes 2026-07-18) into exact expected event sequences; grok coalescing; line-buffer edge cases; decision.ts extraction incl. degraded paths; template rendering; store atomicity (tmp+rename).
- **Engine tests**: mock adapter — happy path (2 stages, fan-out 3), retry loop honoring maxRetries, all-fail, abort mid-stage, stall marking, worktree lifecycle (real temp git repo).
- **API tests**: fastify inject — run lifecycle with mock provider end-to-end, WS event delivery + afterSeq catch-up.
- **Smoke (manual/opt-in)**: `scripts/smoke-real.sh` — starts server, creates temp workspace, runs Planning preset with tiny task using real claude(haiku)+codex+grok+agy, asserts ≥1 event of each category and a gate decision. Not in CI.
- **Acceptance (the "一次到位" bar)**: `npm install && npm run build && npm test` green on Node 24; `npm start` serves UI; the §1 user story executes with real CLIs on castle1; a finished run is replayable after server restart.

## 12. Build-phase module ownership (for the codex fleet)

| Wave | Worker | Owns (exclusive) |
|------|--------|------------------|
| 0 | scaffold | whole tree, all package.json/tsconfig/tailwind/vite, shared/src/** complete, stubs for every module, mock adapter, build+test harness green |
| 1 | W-adapters | server/src/adapters/**, server/src/spawn.ts, server/test/adapters/** |
| 1 | W-engine | server/src/engine/**, server/src/orchestrator/**, server/test/engine/** |
| 1 | W-store-api | server/src/store/**, server/src/api/**, server/src/index.ts, server/test/api/** |
| 1 | W-web-shell | web/src/app/**, web/src/api/**, web/src/panels/workspace/**, web/src/panels/workflow/** |
| 1 | W-web-run | web/src/panels/run/**, web/src/panels/stream/**, web/src/components/** |
| 2 | integrate | cross-module fixes only |

Wave-1 workers MUST NOT edit shared/src/** or another worker's files; contract gaps are reported back, fixed centrally, then re-broadcast.
