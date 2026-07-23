# Multi-AI Terminal — Product & Engineering Spec (v1.5)

> v1.1 incorporates the 4-model panel review (codex gpt-5.6-sol, agy Gemini 3.1 Pro, grok 4.5, Claude Fable 5 — all verdicts: revise; findings merged, see docs/spec-review-panel.md). The normative v1.2 evidence-plane, v1.3 steering/debug-plane, v1.4 evidence-workbench UX, and v1.5 provider-recovery/localized-UI amendments are integrated below and summarized at the end. The BAT-runtime alignment is integrated through product v0.2.10.
> Base date: 2026-07-18. Amended through 2026-07-23.

## 0. What this is

**Multi-AI Terminal (MAT)** is a workflow-orchestration workbench for **headless coding-agent runtimes** (claude, codex, grok, agy, and OpenRouter through Codex-as-runtime). The user composes a workflow (e.g. *Planning Mode*: Orchestrator → Round-Table candidates → Final Reviewer), drags agents onto workflow checkpoints, and watches every agent's live, categorized message stream (**your / agent / tool / thinking**), while a real LLM orchestrator monitors the run and decides advance/retry at each gate.

Successor concept to `multi-ai-chat-desktop` (webchat orchestration), rebuilt on the CLI/agent-SDK path. **Not** a terminal emulator, **not** a fork of better-agent-terminal.

### Decisions locked by the 12-round design debate (do not relitigate)

1. **Do not reuse multi-ai-chat-desktop's runtime** (webview automation). Borrow only UI mental model + design tokens.
2. **Single primary data stream = a headless machine interface.** Workflow nodes use JSONL CLI output, Codex app-server JSON-RPC/JSONL, or the Claude Agent SDK; none uses an interactive PTY, ANSI terminal parsing, or xterm.js. *(The debated "read-only raw-PTY pane" fallback for non-JSONL CLIs is superseded by the `plain` tier in §4.4 — same observability, less machinery.)*
3. **Per-provider runtimes normalize output to one evidence schema.** Native translators plus the single manager bridge own hard-coded mappings. Providers without structured output (agy) remain `plain` tier: stdout streams in as chunked agent text.
4. **Presentation layer is a styled message panel** (React list, four categories + status). This is the product's differentiation, written from scratch.
5. **Orchestrator = a real LLM agent, minimum-branch.** Deterministic trunk (fan-out stage → join → gate → next stage); the LLM decides only at gates: advance / retry(nodes, addendum) / abort, emitting a machine-parseable decision + rationale (decision log is first-class UI data).
6. **Turn-based coordination via job queue + files.** No realtime stdin injection. Fan-in compares normalized events/artifacts.
7. **Node schema is provider-agnostic from day 1.** Multiple instances of one agent at one checkpoint (e.g. 3× grok) is a core interaction.
8. **Mid-run human intervention v1 =** kill node, retry stage, abort run, apply patch, and process-boundary steering. No typing into a live agent session.

### Non-goals (v1)

Interactive terminals/stdin; arbitrary agent-authored runtime graph growth (only retries plus engine-owned transient steer stages); graph-canvas editing (form-based editing + drag-to-assign); locales beyond English and Traditional Chinese; auth beyond network trust + optional token; `gemini` as a separate provider (agy serves Gemini models). Desktop packaging and Windows are shipped surfaces, not non-goals.

## 1. Primary user story

The user opens MAT in the Tauri desktop app or from a headless dev box via browser (Tailscale). The navigation rail switches a persistent Launchpad between **Projects** and **Launch** without discarding either panel's draft. The user picks a workspace, selects **Planning Mode** (builtin), sees provider readiness, types the task, and hits **Start**. Advanced stage/agent editing is available through an explicit **Customize** drawer; edits to a builtin remain an ephemeral run-scoped copy ("Duplicate" only to save). Node cards light up in the activity inspector while the main **Conversation** view identifies which node said what; raw prompts, thinking, tools, lifecycle, and exact ordering remain available in **Timeline**. At the gate, the Orchestrator's decision card explains why R2 is retried with an addendum. The Final Reviewer produces the consolidated plan; the run is replayable after a server restart.

## 2. Architecture & stack

**Topology: single Node.js server process + browser UI, packaged in a Tauri v2 desktop shell.**

- Server: **Node ≥ 20, TypeScript, Fastify** (REST + WebSocket + static hosting). Drives headless CLI, Agent SDK, and JSON-RPC app-server runtimes, persists normalized evidence, and broadcasts only after durable append.
- Frontend: **React 18 + Vite + TypeScript + Tailwind CSS + zustand + @dnd-kit/core + @tanstack/react-virtual**. Backend touchpoints ONLY via `web/src/api/client.ts` (REST) and `web/src/api/ws.ts` (WS).
- Shared package: **zod schemas + TS types** consumed by both sides.
- Monorepo: npm workspaces (`shared/`, `server/`, `web/`). ESM, TS strict. Engines `>=20`.

The web-served topology remains the runtime contract because it works on headless servers over Tailscale and is independently browser-testable. The shipped Tauri v2 shell launches that same bundled Fastify server on an ephemeral loopback port and navigates its WebView to it; it does not replace the server architecture. *(Deviation from debate round 12, deliberate: "reuse BAT peripheral scaffolding" was dropped because BAT is Tauri-bound; its lifecycle/worktree patterns are re-specified natively here.)*

**Bind & trust**: default `--host 127.0.0.1`. `--host 0.0.0.0` (or a tailscale IP) opts into remote access; v1 trust model is the network boundary (tailnet ACLs). Optional `--token <secret>` (or `MAT_TOKEN`): when set, REST requires `Authorization: Bearer <secret>` and WS requires `?token=<secret>`; when unset, no auth. Server never exposes itself beyond the chosen bind.

### Repo layout

```
multi-ai-terminal/
├── package.json                # workspaces root; scripts: dev, build, test, start, typecheck
├── SPEC.md  README.md  LICENSE  docs/spec-review-panel.md
├── desktop/src-tauri/          # Tauri v2 shell, capabilities, native plugins, packaging
├── scripts/                    # desktop bundle, browser smoke, version synchronization
├── tools/evidence/             # built-server and extracted-artifact black-box instruments
├── shared/
│   └── src/
│       ├── events.ts providerEvents.ts workflow.ts run.ts providers.ts api.ts   # types + zod (§3)
│       ├── presets/planning.json build.json review.json       # §10
│       └── index.ts
├── server/
│   ├── src/
│   │   ├── index.ts            # mat-server [--port 7788] [--host 127.0.0.1] [--data-dir …] [--token …]
│   │   ├── spawn.ts            # §4.7 sanitized-env process-group spawn
│   │   ├── runtime/            # pinned catalog installer, resolver, mutation triggers
│   │   ├── providers/          # contract.ts + claude/codex/grok/agy/openrouter managers
│   │   ├── adapters/           # base.ts claude.ts codex.ts grok.ts agy.ts openrouter.ts mock.ts registry.ts
│   │   ├── engine/             # runManager.ts stageRunner.ts nodeRunner.ts digest.ts worktree.ts
│   │   ├── orchestrator/       # gate.ts decision.ts prompts.ts
│   │   ├── store/              # dataDir.ts workspaces.ts workflows.ts runs.ts eventLog.ts
│   │   └── api/                # routes.ts wsHub.ts
│   └── test/                   # vitest; fixtures/ = cleaned REAL CLI captures (§11)
└── web/
    └── src/
        ├── app/                # App shell, layout grid, semantic theme tokens, store.ts (zustand)
        ├── api/                # client.ts ws.ts
        ├── i18n/               # persisted language/theme preferences + en/zh-TW dictionaries
        ├── components/         # AgentChip StatusDot ModalDialog Collapsible EventRow…
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
5. **Events are immutable.** Streaming deltas (grok tokens, agy stdout) are coalesced per (nodeRunId, kind) and flushed on kind-change, ≥1500 ms, or ≥2 KB buffer — each flush appends a NEW event with `data:{continued:true}` after the first. The Narrative projection and digest builder may merge only adjacent, identity-compatible continuation events into one readable/logical block. Timeline retains every source event with its original `id` and `seq`; tool halves and duplicate prompts may receive adjacent-only visual grouping, but the representation must expand back into monotonically increasing source sequence order.
6. Non-JSON stdout lines from `rich`-tier CLIs are silently skipped for normalization but always land in the raw log.
7. Every raw stdout/stderr line is appended to `raw/<nodeRunId>.a<attempt>.jsonl` as `{s:'out'|'err', l:string, ts:number}` after source-aware environment-value redaction. Ordering and stream identity are preserved; secrets are not.

### 3.1.1 Internal provider-manager surface

`shared/src/providerEvents.ts` defines BAT's provider-neutral, strict 19-event manager surface. The historical `claude:*` namespace is intentionally shared by every provider:

`claude:message`, `claude:tool-use`, `claude:tool-result`, `claude:stream`, `claude:status`, `claude:result`, `claude:turn-end`, `claude:error`, `claude:rate-limit`, `claude:task`, `claude:permission-request`, `claude:permission-resolved`, `claude:ask-user`, `claude:ask-user-resolved`, `claude:modeChange`, `claude:history`, `claude:resume-loading`, `claude:session-reset`, and `claude:worktree-info`.

This manager contract is not a second durable event log:

1. Every provider event carries `sessionId`. Every `claude:status` carries one full `ProviderSessionMeta` snapshot; consumers never merge partial status patches. Every started provider turn terminates with exactly one `claude:turn-end` (`completed | error | interrupted | aborted`).
2. `server/src/providers/contract.ts` owns the single provider-to-evidence bridge. It canonicalizes common tool names (`Bash`, `Edit`, `WebSearch`, `TodoWrite`), projects content and technical status, suppresses provider-history replay, and folds provider terminal metadata into `NodeOutcome.providerTurn`.
3. The adapter IO boundary remains §3.1 rule 1: adapters emit content only. Current production managers feed `AdapterContentEvent` through `acceptContent()`; the richer event shapes are validated compatibility ingress reserved for future native manager emitters and do not make those features reachable today. Neither path stamps durable identity or appends lifecycle events.
4. `nodeRunner` remains the sole lifecycle mapper and durable writer for provider evidence. Provider `result`, fatal `error`, and `turn-end` metadata enrich the one engine-owned terminal result/error path; they never create a parallel provider-owned lifecycle sequence. Technical provider state is emitted as system/status evidence and does not mutate `NodeRun.status`.
5. `eventLog.append` remains the only authority for durable `id`, `seq`, and `ts`, and still appends before broadcast. Provider ids/timestamps are provenance only. MAT's `events.jsonl`, not `claude:history`, is replay authority.

Contract tests live at `server/test/providers/contract.test.ts`. The independent built-server instrument is `tools/evidence/repro-runtime-contract.mjs`, backed by `tools/evidence/fake-codex-runtime.mjs`.

### 3.2 Workflow definition

```ts
// shared/src/workflow.ts
export type ProviderId = 'claude' | 'codex' | 'grok' | 'agy' | 'openrouter' | 'mock';
export interface AgentBinding {
  provider: ProviderId;
  model?: string;                       // free text; UI suggests via /api/providers
  effort?: 'low' | 'medium' | 'high' | 'xhigh';   // mapped per provider; ignored where N/A
  permission: 'safe' | 'auto' | 'full';           // §4.6
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
  verificationSummary?: {                    // frozen at decision time; optional for persisted legacy runs
    passed: number; failed: number; skipped: number;
  };
  ts: number;
}
export interface RunSnapshot {
  runId: string; workspaceId: string;
  workspaceSnapshot?: {                     // immutable provenance; absent only on legacy persisted runs
    name: string; path: string; isGit: boolean;
    verifyCommand?: string; verifyTimeoutSec?: number;
  };
  workflow: WorkflowDef;                     // immutable resolved copy — the only workflow source at runtime
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
  runtimeCommand?: string;                   // nodeRunner-resolved managed/external runtime
  runtimeNodeCommand?: string;               // Node used by Codex helper scripts
}
export interface NodeOutcome {
  exitCode: number | null; signal?: string;
  sessionRef?: string; usage?: Usage;        // camelCase; adapters convert CLI casing
  resultText?: string;                       // accumulated by the adapter during streaming
  error?: string;
  providerTurn?: {                           // terminal manager metadata; not a second lifecycle event
    event: 'claude:turn-end'; sessionId: string;
    reason: 'completed' | 'error' | 'interrupted' | 'aborted';
    status: ProviderSessionMeta;
  };
}
export interface SpawnedNode { pid: number; kill(sig?: NodeJS.Signals): void; completion: Promise<NodeOutcome> }
export interface Adapter {
  id: ProviderId; tier: 'rich' | 'plain';
  runtimeFamily?: 'claude' | 'codex';
  environmentCredential?(): { name: string; configured: boolean };
  available(): Promise<{ ok: boolean; version?: string; detail?: string }>;
  spawn(spec: ResolvedNodeSpec, io: { onEvent(e: AdapterContentEvent): void;
                                      onRaw(line: string, stream: 'out'|'err'): void }): SpawnedNode;
  models: string[]; defaultModel: string;
}
```

- Adapters accumulate agent text internally; `NodeOutcome.resultText` = final agent message (never assume the CLI's terminal event carries it).
- The adapter callback remains content-only. `ProviderTurnBridge` wraps every real provider at the engine boundary and owns manager status/terminal projection; `mock` remains deliberately exempt.
- Prompt delivery (ARG_MAX safety): Claude Agent SDK and Codex app-server use their machine protocols; legacy claude/codex transports use stdin; grok uses `--prompt-file`; agy uses argv (cap 200 KB, else a failed outcome).
- Binary resolution: `MAT_<FAMILY>_BIN` absolute override → catalog-pinned managed path → PATH-discovered runtime. On desktop startup, missing supported managed artifacts may be bootstrapped automatically; every artifact is verified before publication and stored below `<dataDir>/runtimes/`.

### 4.1 claude (rich) — Agent SDK session runtime; legacy CLI fixture path

The production path uses `@anthropic-ai/claude-agent-sdk` with a per-session streaming `LiveQuery`, resume/rebuild semantics, interrupt support, and the resolved catalog-pinned `claude` executable. `MAT_CLAUDE_RUNTIME=cli` is an explicit legacy mode, not an automatic failover. Its verified one-shot invocation remains:

```sh
<prompt on stdin> claude -p --output-format stream-json --verbose \
  [--model M] [--permission-mode PM] [--max-turns N] [--resume SESSION_ID]
```
- `--verbose` REQUIRED with `-p` stream-json.
- Legacy mapping: `system/init` → capture sessionRef; `assistant.message.content[]`: `text`→agent/message, `thinking`→thinking/thinking, `tool_use`→tool/tool_use (toolCallId=id, input JSON-stringified, 4 KB truncate); `user.message.content[].tool_result`→tool/tool_result (toolCallId=tool_use_id, 4 KB truncate); `result`→outcome {exitCode 0, usage {inputTokens:usage.input_tokens, outputTokens:usage.output_tokens, costUsd:total_cost_usd}, resultText: result ?? accumulated}. Skip `rate_limit_event`, `system/*` others (raw log only).
- Legacy effort is not mapped. Legacy resume uses `--resume <sessionRef>` + a new prompt on stdin; the Agent SDK runtime owns production session continuity.

### 4.2 codex (rich) — persistent app-server runtime; legacy CLI fixture path

The production path is one lazy shared `codex app-server` JSON-RPC/JSONL controller with per-session serialization, thread ownership/resume, turn interrupt, stale-event filtering, approval handling, and idle recycle. `MAT_CODEX_RUNTIME=exec` is the explicit one-shot legacy mode. Its verified invocation remains:

```sh
codex exec --json -m gpt-5.6-sol [-c model_reasoning_effort=E] --cd <CWD> \
  --sandbox <MODE> --skip-git-repo-check -      (prompt on stdin via '-'; never leave stdin open)
```
- Legacy mapping: `thread.started`→sessionRef=thread_id; `item.started {item.type:'command_execution'}`→tool/tool_use (toolCallId=item.id, name 'shell', input=command); `item.completed {command_execution}`→tool/tool_result (output=aggregated_output, isError=exit_code≠0); `item.completed {agent_message}`→agent/message (resultText=last); `item.*` reasoning→thinking; unknown item types→tool rows named by item.type; `turn.completed`→usage {inputTokens, outputTokens}; `turn.failed`/`error`→error.
- `--skip-git-repo-check` always (non-git workspaces are supported).
- effort map low|medium|high|xhigh → `-c model_reasoning_effort=<v>`.
- Resume (orchestrator only): `codex exec resume <thread_id> --json -m <same> -c model_reasoning_effort=<same> --cd <same> --sandbox <same> --skip-git-repo-check -` — ALL flags re-passed explicitly.

### 4.3 grok (rich) — verified, Grok Build TUI headless (fixtures: grok.jsonl, grok-tool.jsonl)

The streaming-JSON transport is wrapped by the common FIFO `CliSessionManager`; the manager preserves resumable-session serialization and normalizes killed/error outcomes without changing the transport's observable event tier.

```
grok --prompt-file <FILE> --output-format streaming-json [-m grok-4.5] \
  [--reasoning-effort E] --cwd <CWD> [--permission-mode PM] [--max-turns N]
```
- grok ≥ 0.2.93: `-p/--single` takes an inline prompt VALUE; do not combine it with `--prompt-file` (live-smoke verified 2026-07-18: `--prompt-file` alone selects headless mode).
- **Probe-confirmed reality: streaming-json emits ONLY `thought`/`text`/`end` events.** Tool calls execute silently between thought tokens — there are NO tool events in v1; grok nodes show no tool rows and the digest reports tool-count "n/a" for grok. Unknown event types, if they ever appear, → tool rows named by type (forward-compat).
- `thought` deltas → coalesce → thinking; `text` deltas → coalesce → agent/message (resultText = full text); `end` → outcome {exitCode 0, sessionRef=sessionId}. Silent gaps during tools are expected — see §5 stall.
- Resume (orchestrator only): `grok -r <sessionRef> --prompt-file <FILE> --output-format streaming-json` + same flags.
- Orchestrator-as-grok bonus: pass `--json-schema` for hard decision enforcement.

### 4.4 agy (plain) — verified; Antigravity CLI, no JSON mode (fixture: agy.log)

The plain-text transport is wrapped by the same FIFO `CliSessionManager` but remains non-resumable. The manager does not invent tool evidence or a richer native protocol.

```
agy -p "<PROMPT>" --model "Gemini 3.1 Pro (High)" [--print-timeout 45m] [--dangerously-skip-permissions]
```
- **Streams stdout incrementally**: chunks coalesce (§3.1 rule 5) into agent/message events as they arrive (liveness); resultText = full accumulated stdout; non-zero exit → error event with stderr tail.
- Model catalog (from CLI): `Gemini 3.5 Flash (Medium|High|Low)`, `Gemini 3.1 Pro (Low|High)`, `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)`. effort picks the matching (High|Low) display-name variant when the base model matches; else ignored.
- No resume v1. Default stall floor 600 s (§5).

### 4.5 openrouter (rich) — Codex-as-runtime

OpenRouter has no CLI or agent runtime of its own. MAT drives it through the same persistent Codex app-server with `modelProvider:'openrouter'`, a fixed OpenAI-compatible provider config under an isolated `<dataDir>/openrouter-codex-home`, and `OPENROUTER_API_KEY` passed only to the child environment. No OpenAI/Codex OAuth credential is copied into that home, and MAT never persists or exposes the OpenRouter key value.

`GET /api/providers/openrouter/models` loads the bounded public catalog with live/stale/fallback provenance. The UI first selects a model group and then a version. The selected version id — including a `~vendor/model-latest` alias or a pinned vendor slug — is the exact request slug persisted in `AgentBinding.model` and sent to `thread/start`/`turn/start`; MAT must not reconstruct it from a display label. Custom exact slugs remain available. Tool quality and supported features vary by the selected upstream model and are surfaced honestly.

### 4.6 Permission tier mapping (implementer: verify each flag against `--help`; nearest safe equivalent + comment if absent)

| tier | claude | codex | grok | agy | openrouter |
|------|--------|-------|------|-----|------------|
| safe | `--permission-mode plan` | `--sandbox read-only` | `--permission-mode plan` | prompt-level read-only instruction | Codex `read-only` sandbox |
| auto (default) | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--permission-mode acceptEdits` | — | Codex `workspace-write` sandbox |
| full | `--dangerously-skip-permissions` | `--sandbox danger-full-access` | `--permission-mode bypassPermissions` | `--dangerously-skip-permissions` | Codex `danger-full-access` sandbox |

### 4.7 spawn.ts — process hygiene

- env: inherit minus `LD_LIBRARY_PATH` (BAT AppImage breaks child TLS); ensure PATH includes `~/.local/bin`, `/usr/local/bin`.
- `stdio: ['pipe'|'ignore','pipe','pipe']` per adapter (stdin pipe only to write the prompt, then end()).
- **Process groups**: spawn `detached: true`; kill via `process.kill(-pid, sig)`; SIGTERM → SIGKILL escalation after 10 s. Never parent-only kills (CLIs spawn shells/compilers).
- On win32, spawn without detaching and terminate the full process tree with forced `taskkill /PID <pid> /T /F` instead of POSIX signals.
- Incremental line buffer (partial lines, multi-line chunks, CRLF).
- Per-attempt hard timeout (stage.timeoutSec) → group-kill + `failed` (detail 'timeout').

### 4.8 mock (rich)

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

- run.json persists `pid` per live node. On server boot: any run with non-terminal status → best-effort platform process-tree kill of recorded pids, prune its worktrees, mark run `aborted` + system event `status {detail:'server-restart'}`; nodes left `running` → `killed`.
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
GET  /api/providers                           → [{id, tier, ok, version?, detail?, models, defaultModel,
                                                installable, manualCommand?, authAlert?, signInCommand?}]
POST /api/providers/refresh                   # no body; clears local PATH/version caches and reruns discovery
POST /api/providers/:id/install               # explicit click only; fixed server-side recipe or manual command
POST /api/client-log                          # bounded best-effort browser diagnostic intake
GET  /api/debug/server-log                    # bounded server diagnostic tail
GET|POST|PATCH|DELETE /api/workspaces(:id)    # POST validates path exists; returns isGit
GET  /api/workflows                           → builtin + custom
POST /api/workflows  PATCH|DELETE /api/workflows/:id    (builtin → 409; POST /api/workflows/:id/duplicate)
POST /api/runs                                RunCreateRequest → RunSnapshot (auto-starts)
GET  /api/runs?workspaceId=&limit=50&before=<createdAt>   → RunSnapshot[] (newest first, cursor = createdAt)
GET  /api/runs/:id                            → RunSnapshot
GET  /api/runs/:id/events?afterSeq=0&limit=1000 → AgentEvent[]
GET  /api/runs/:id/report                     → text/markdown deterministic evidence report
GET  /api/runs/:id/debug-bundle               → application/zip debug bundle v1
GET  /api/runs/:id/patches/:nodeRunId         → text/plain latest-attempt patch content
POST /api/runs/:id/abort
POST /api/runs/:id/nodes/:nodeRunId/kill
POST /api/runs/:id/steer                      SteerRequest — FIFO interrupt (default) or queue
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

Evidence workbench: an 84 px icon+text navigation rail, collapsible Launchpad, collapsible activity inspector, and a flexible Run Workspace. Launchpad/inspector widths use the independent `mat-shell-layout-v2` preference and keyboard-accessible dividers. Collapsing or navigating hides panels without unmounting them, so task, workspace, and model-editor drafts survive.

1. **Projects**: workspace cards — name, short path, `lastRun` badge ("Planning · done · 2h ago"), live pulse when running; add-workspace dialog (server validates; shows isGit chip). Projects is a Launchpad view selected from the rail, not a permanently competing column.
2. **Launch**: the default Launchpad view leads with visual workflow-mode choices, provider readiness, task, and Start. "CLI detected" never claims authentication; a recent observed auth failure is labeled as such. **Customize** opens the advanced stage editor, orchestrator binding, slot editors, and agent palette in a focus-trapped drawer. Slot editing keeps the explicit custom-model input: never use `<datalist>` and never auto-collapse while a custom value is being typed. Editing a builtin mutates an ephemeral run-scoped `workflowOverride`; Duplicate is required to save it.
3. **Activity inspector**: the existing run/node evidence controls stay persistently mounted. Stage groups and node cards show provider identity, state, elapsed time, last evidence, usage, verification, handoff, patch, kill/retry controls, steering, Report, and Debug. The rail may hide this region without discarding dialog or composer state.
4. **Run Workspace**: one shared run selector owns live/history identity and replay hydration for every evidence view. It must never replace `activeRunId` when the user chooses a historical `viewedRunId`. Node chips plus All/Running/Attention presets focus both the inspector and evidence views. A run that finishes while open remains the same live session for follow/read controls; a terminal run selected after reload is a replay.
5. **Conversation (default)**: a virtualized Narrative projection emphasizes agent messages, decisions, verification, and errors. Each block identifies node label, provider/model, stage, attempt, source sequence, and time. Source `seq` is authoritative; every source event appears in exactly one projection item; gaps are explicit items; grouping never crosses a gap/node/stage/attempt/role/kind boundary. Tool use/result pair only when adjacent and identity-compatible. Prompts, thinking, tools, and lifecycle are hidden by default but remain searchable and available through **Tools & thinking**. Narrative is a projection only; it never rewrites durable evidence.
6. **Timeline**: the raw virtualized feed remains available with node/role/search filters and expandable tool evidence. It preserves chronological source order and adjacent-only compaction. Auto-follow disarms on intentional upward reading, re-arms at the bottom, and remains usable if the live run completes while open. Replay is hydrated by the parent Run Workspace, not a second competing selector.
7. **Health & diagnostics**: a header drawer performs observational server/provider checks and derives workspace, viewed-run, node, verification, degraded-gate, WebSocket, and evidence-continuity findings. Provider `ok` means CLI discovery only; authentication is unknown unless a recent failure was observed. `mock` is always a deterministic non-issue. Safe actions are fixed-recipe Setup/sign-in copy, explicit cache-bypassing provider recheck, node inspection, redacted server-log loading, and debug-bundle export; no run retry/kill/apply mutation belongs in Health.
8. **Live evidence continuity**: a WebSocket sequence jump sets a visible recovering state, buffers concurrent live events, backfills from persisted REST evidence, merges/deduplicates by sequence, and becomes `incomplete` with explicit Retry when recovery fails. A later gap must retain the earliest unresolved cursor. Existing evidence remains visible, but the UI must not imply completeness while recovery is unresolved.
9. **Language + theme tokens**: system/en/zh-TW language and Midnight/Daylight/Aurora theme choices persist in `mat-ui-preferences-v1`; `main.tsx` applies them before React mounts. Visible chrome and troubleshooting copy must use the typed dictionary. Neutral surfaces/text use semantic `canvas/panel/surface/raised/control/border/ink/muted` tokens rather than fixed zinc colors. Aurora is a restrained violet/gold/teal palette; provider identity colors remain claude `#d97706`, codex `#10a37f`, agy `#4285f4`, grok `#e11d48`, mock `#71717a`.
10. **zustand store**: state includes workspaces, workflows, providers, workspace selection, ephemeral workflow edits, separate active/live and viewed/replay run identities, run snapshots, bounded per-run event windows (the server remains the complete record), WebSocket/evidence-integrity state, filters, and focused-node UI state. Panels consume it through stable selectors; selectors must not allocate fresh fallback arrays or objects because that caused the React #185 black-screen loop.

## 10. Builtin presets (shared/src/presets) — also the reference examples for §6.2

1. **planning.json** — Round Table (gate ✓, isolation none): R1 codex/gpt-5.6-sol/high, R2 claude/sonnet, R3 grok/grok-4.5 — independent implementation plans. Final Review: claude/opus, permission safe, template uses `{{prior_stage_digest}}`. Orchestrator claude/sonnet enabled.
2. **build.json** — Implement (isolation worktree, gate ✓): codex/gpt-5.6-sol/high ×2. Review: grok + claude on `{{patches}}`. Orchestrator enabled.
3. **review.json** — Review (permission safe, gate off): claude, codex, grok, agy ×1. Synthesize: claude merges verdicts via `{{prior_stage_digest}}`. Orchestrator disabled.
4. **pipeline.json** — Implement → Test → Review: worktree-isolated implementation and test stages carry patches and verification evidence forward; `requireVerified` protects the evidence gates.

## 11. Testing & acceptance

- Fixtures: **cleaned real captures vendored by wave-0 from `/tmp/mat-probes/clean/`** → `server/test/fixtures/{claude.jsonl, claude-tool.jsonl, codex.jsonl, codex-tool.jsonl, codex.dirty.jsonl, grok.jsonl, grok-tool.jsonl, agy.log}`. `codex.dirty.jsonl` (stderr banner interleaved) exercises §3.1 rule 6.
- Unit: adapters × fixtures → exact expected event sequences incl. coalescing and outcome fields; line-buffer edges; decision.ts (happy, re-ask, degraded, invalid-id filtering); template rendering; digest budget math; store atomicity + seq recovery.
- Engine (mock adapter): happy 2-stage fan-out 3; retry loop honoring budgets + `status:retry` boundaries + user-event synthesis per attempt; all-fail; abort mid-stage; stall mark+recover; worktree lifecycle incl. retry re-add and untracked-file patch capture (real temp git repo); crash sweep (simulated stale run.json).
- API: fastify inject — full run lifecycle with mock provider, WS order = after-append, afterSeq catch-up, retry-stage validity matrix, apply-patch 3way conflict path, token auth on/off.
- Browser smoke: `npm run smoke:browser` launches the built server and production React bundle in real Chrome/Chromium; it guards mount, compact shell geometry, visible navigation labels, zh-TW and three-theme persistence, Health semantics, Narrative-first rendering, Timeline scrolling/follow mode, live switching/completion, verification/report, steering, and debug export. CI must keep this on Linux and Windows because jsdom missed the React #185 black screen.
- Artifact evidence: `npm run evidence` runs five independent black-box instruments: `tools/evidence/repro-v016.mjs`, `repro-v017.mjs`, `repro-v018.mjs`, `repro-v019.mjs`, and `repro-runtime-contract.mjs`. The last uses `fake-codex-runtime.mjs` to prove OpenRouter's exact model/provider routing, canonical evidence projection, redaction, and restart replay without a real credential or provider request. Release acceptance reruns the complete suite against the extracted `.deb` with `MAT_ROOT` and `MAT_EXPECT_VERSION`.
- **Acceptance**: `npm ci && npm run verify:version && npm run build && npm test && npm run typecheck && npm run evidence && npm run smoke:browser` green on the applicable CI lanes; `npm start` serves UI; §1 story executes with real provider runtimes; a finished run replays after server restart; crash sweep leaves no orphan processes/worktrees.

## 12. Historical build-phase module ownership (codex fleet; non-normative)

> **Historical record only.** This table and §12.1 describe the one-time initial
> build-wave scaffold. They do not freeze files, grant current workers exclusive
> ownership, or override `HANDOFF.md`, `AGENTS.md`, the current schemas, or the
> implementation. Do not use this section to plan present-day edits.

| Wave | Worker | Initial assignment (historical) |
|------|--------|------------------|
| 0 | scaffold | whole tree; all package/tsconfig/tailwind/vite; shared/src COMPLETE; web/src/components/** COMPLETE; web/src/app/store.ts COMPLETE; api client/ws; mock adapter COMPLETE; eventLog + dataDir COMPLETE; stubs elsewhere; fixtures vendored; build+test green |
| 1 | W-adapters | server/src/adapters/** (incl. mock.ts — keep wave-0 mock tests green), server/src/spawn.ts, server/test/adapters/** |
| 1 | W-engine | server/src/engine/**, server/src/orchestrator/**, server/test/engine/** |
| 1 | W-store-api | server/src/store/{workspaces,workflows,runs}.ts, server/src/api/**, server/src/index.ts, server/test/api/** |
| 1 | W-web-shell | web/src/panels/workspace/**, web/src/panels/workflow/**, web/src/app/App.tsx + layout (NOT store.ts) |
| 1 | W-web-run | web/src/panels/run/**, web/src/panels/stream/** |
| 2 | integrate | cross-module fixes only |

### 12.1 Historical internal seams used by the initial build

- `store/eventLog.appendEvent(runId, partial: Omit<AgentEvent,'id'|'seq'|'ts'>): AgentEvent` — sync assign+append, THEN caller-visible; wsHub subscribes to appends (never broadcasts unappended events).
- `engine/runManager`: `createRun(req: RunCreateRequest): Promise<RunSnapshot>`, `abortRun(runId)`, `killNode(runId, nodeRunId)`, `retryStage(runId, stageId, req)`, `applyPatch(runId, nodeRunId)`, `sweepOnBoot()` — the complete surface routes.ts consumes.
- Adapter contract exactly §4.0; nodeRunner is the only event stamper; store.runs persists RunSnapshot atomically.
- During that build only, wave-1 workers did not edit shared/src/**, web/src/components/**, web/src/app/store.ts, package.json, or another worker's files; contract gaps were reported and integrated centrally. This is not a current ownership rule.

## v1.2 — Evidence plane (2026-07-19)

Workspaces may configure `verifyCommand` and `verifyTimeoutSec` (effective engine default: 600 seconds). After a worktree-isolated Git candidate captures a non-empty patch, the engine runs the command in that candidate worktree and persists a strict normalized result (`passed | failed | error | skipped`), bounded output tail, and full atomic log artifact. No command, no changes, and non-completed nodes are explicit skipped states; stages without actual verification remain compatible.

Stages add `requireVerified`, default false. At a gated stage, an orchestrator `advance` is replaced with a targeted retry exactly when at least one candidate verification failed or errored and no candidate passed. The existing retry-budget clamp remains authoritative, so the predicate is fail-open at exhaustion; that advance is persisted and emitted as degraded. Generated, reviewed, advanced, and verified are separate states, and degraded or unverified advancement remains honestly labeled in the run UI and report.

Each node snapshot records its handoff inputs: prior node IDs and whether orchestrator context or a retry addendum entered its seed prompt. Run creation snapshots the detected CLI versions of providers actually bound by the workflow. `GET /api/runs/:id/report` deterministically renders Markdown containing run metadata, provider versions, aggregate usage, candidate/diff/verification evidence, handoffs, chronological gate decisions, failed check logs, and terminal result excerpts. The Pipeline preset implements the shortest Implement → Test → Review production line with evidence gates between worktree stages.

Explicitly deferred: human approval/pause nodes, pre-tool policy hooks, and live adapter contract tests. These require separate trust and lifecycle contracts and are not implicit in verification evidence.

## v1.3 — Steering & debug plane (2026-07-20)

An active run accepts up to eight FIFO steer messages. `interrupt` is the default: at a running-stage checkpoint it requests the existing SIGTERM process-tree kill, preserves partial transcripts, raw logs, patches, and verification evidence, executes the new instruction as a transient `steer-N` stage, then records a gate decision that retries the interrupted stage, advances, or aborts. `queue` does not kill work and applies at the next stage boundary. A retry chosen by steer review increments candidate attempts but does not consume the stage gate retry budget. Newer interrupts may supersede an active steer; messages still pending or active when a run ends become expired. Every terminal transition is durable and evented.

Steer review uses the configured orchestrator with retry IDs restricted to the interrupted stage. At a boundary, retry is unavailable and an invalid retry degrades to advance. With orchestration disabled, interruption deterministically retries with the steer outcome as an addendum, while a boundary steer deterministically advances with context for the next stage. Steering remains a process-boundary facility: the no-PTY decision is reaffirmed, and the engine never writes to a running child's stdin.

The debug plane writes best-effort JSONL diagnostics for run, stage, spawn/exit, verification, gate prompt/raw response, decision, steer, API/client error, provider probe, and unhandled engine error activity. Diagnostic failure never enters engine control flow, and environment variable values must not be logged. Bundle format v1 is a read-only zip containing a manifest, snapshot, complete events, run diagnostics, report, raw adapter output, patch/verification artifacts, and the final 512 KB of server diagnostics. Client error intake accepts at most 200 entries per server boot.

Explicitly deferred: pause/resume, human approval nodes, and a steer-time agent picker.

## v1.4 — Evidence-workbench UX (2026-07-20)

The four equal-weight columns are replaced by an explicit information hierarchy: navigation rail → persistent Launchpad → activity inspector → Run Workspace. Basic launch configuration is visible first; advanced stage/agent editing is opt-in and preserves all existing workflow contracts. Conversation is the default evidence view and gives every message a stable node/provider/stage/attempt identity, while Timeline remains the complete technical renderer. Both views share one viewed-run selector and replay loader.

Live evidence is no longer silently trusted across a WebSocket sequence gap. The browser visibly recovers persisted events, buffers simultaneous arrivals, preserves the earliest unresolved gap, and exposes an incomplete/retry state if backfill fails. Health centralizes honest, read-only troubleshooting and safe exports without claiming that CLI detection proves authentication or adding run mutations.

This amendment changes presentation and web-local state only. It adds no PTY, interactive terminal, pause/resume, human approval node, canvas/multi-pane workflow, or new shared persisted schema.

## v1.5 — Provider recovery & localized UI (2026-07-21)

A field debug bundle proved that healthy Codex and Grok Windows shims could exceed the former five-second cold version probe, after which the failure was mislabeled as unavailable and cached for ten minutes. Version probes now allow 15 seconds on Windows and eight elsewhere, share only in-flight work, cache successful results for ten minutes, and cache failures for two seconds. `POST /api/providers/refresh` takes no user input, clears augmented-PATH and version caches, and reruns discovery. The UI exposes this as **Retry detection** in Setup and **Recheck providers** in Health; neither action installs software or changes a run.

Agy's fixed Windows `winget` recipe may run for several minutes, so its provider-specific timeout is ten minutes. Setup shows elapsed time, automatically rechecks on completion, and keeps an explicit ready/no-restart or installed-but-not-detected/restart-once result visible. The security boundary remains unchanged: installation requires an explicit click, runs only a fixed server recipe, and accepts no command input. The later managed-runtime amendment supersedes the old Claude/Codex Setup path with catalog-pinned, integrity-verified artifacts under the MAT data directory.

The chrome follows the system language or persists English/Traditional Chinese, and persists one of Midnight, Daylight, or violet/gold/teal Aurora. Navigation icons have visible text; Conversation cards strengthen node label, provider/model, stage, attempt, sequence, time, and provider-color identity. These preferences and translations are web-local only and add no shared persisted schema or engine behavior.

## BAT provider-runtime alignment (released through v0.2.10)

Product releases v0.2.5–v0.2.9 added the catalog-pinned managed Claude/Codex runtime layer, persistent Codex app-server and Claude Agent SDK production paths, and BAT-aligned Codex/Claude account handling. Desktop startup may quietly bootstrap missing supported managed runtimes; downloads are pinned and integrity-verified before atomic publication under the data directory. Provider-specific recipes remain fixed server-side actions and accept no command input.

Product v0.2.10 wraps Grok and Agy transports in the common manager pattern, adds OpenRouter through Codex-as-runtime, and adds the canonical manager/evidence bridge defined in §3.1.1.
