# Handover — continuation work for codex (written 2026-07-23, post v0.2.9)

You are gpt-5.6-sol running `codex exec` inside the MAT repo. This note is your work order context. Read `HANDOFF.md` and `AGENTS.md` first — they are the canonical repo contract; this note adds current state and the next tasks.

## Where the project stands

- **Released: v0.2.9** (tag `v0.2.9`, HEAD `0f57c11` on `main`, tree clean). BAT port plan (`docs/bat-port-plan.md`) phases done so far: §2 runtime catalog + managed installer (#20, v0.2.5–7), §3 codex app-server session runtime + claude Agent SDK runtime (#21/#22, v0.2.8), §4 auth/accounts alignment (#23, v0.2.9).
- #23 delivered: codex unified account store (`server/src/providers/codex/accounts.ts` — capture/switch/remove/sync, path-safe ids via shared `CODEX_ACCOUNT_ID_PATTERN`, switch re-snapshots outgoing + re-captures same-target), OpenAI API-key chain (`apiKey.ts`, file 0600 → env; exec env injects file-source only via `codexExecEnv`), needs-login marking wired in `engine/nodeRunner.ts` (suppressed when an API key is configured), sign-in/turn/mutation mutual exclusion (synchronous ceremony reservation in `providers/signin.ts`, reciprocal guard in `nodeRunner`), claude read-only accounts reader, ProviderSetup UI section, HANDOFF §Security 3 updated. All grok-review findings closed (final verdict PASS).
- Deliberately deferred in #23 (do NOT build unless a work order asks): BAT's resolve-with-install during sign-in (MAT keeps installs explicit), native keyring for the API key (file+env is the headless baseline), in-protocol device-code login over app-server RPC (child-process login flow retained).

## Next tasks (in order)

### #24 — grok/agy manager pattern + OpenRouter as provider #5 (plan §5)
- Wrap grok and agy in the same manager/runtime pattern claude/codex now use (managed runtime resolution where applicable, canonical auth-failure marking, sign-in recipes already exist in `providers/signin.ts`).
- Add OpenRouter as the fifth provider using **codex-as-runtime** (BAT's `sakana` precedent: a codex binary pointed at OpenRouter via env/config, NOT a new CLI). Follow BAT's adapter shape; refresh the reference first:
  `git clone --depth 50 https://github.com/tony1223/better-agent-terminal /tmp/mat-refs/better-agent-terminal` — baseline commit `0e24800`; if upstream moved, diff per plan §8 before porting.
- `RuntimeFamily` is `'claude' | 'codex' | 'node'` — grok/agy/openrouter are NOT runtime families; only add a family if the plan section says so.

### #25 — evidence mapping + canonical event contract (plan §6), then release
- Map provider events onto the canonical `AgentEvent` contract per plan §6; extend `scripts/evidence` instruments to cover the runtime overhaul; release per the playbook in `HANDOFF.md` (six version files → lock sync → verify:version → CI → tag → notes → .deb evidence with `MAT_EXPECT_VERSION` → publish). Tempo: each phase releases the day it is green.

## Hard rules (violations = rejected work)

1. Run every test from the **repo root** with:
   `env -u LD_LIBRARY_PATH -u CLAUDE_CODE_CHILD_SESSION -u XDG_SESSION_ID npm test`
   (those env vars trip the redactor's `_session` matcher — never "fix" the redactor; the env is at fault).
2. Tests must NEVER touch the real `~/.codex` or real data dir: always fake `CODEX_HOME` (temp dir) and temp `MAT_DATA_DIR`/`configureDataDir`. Never run real provider login commands; never copy `auth.json` between CODEX_HOMEs by hand (the product switcher is the only sanctioned mover).
3. Real provider binaries SIGSEGV under vitest workers in this sandbox. Real-binary smokes run through plain-node dist runners (`/tmp/mat-real-turn-smoke.mjs`, `/tmp/mat-claude-real-smoke.mjs` — rebuild `npm run build` first). In vitest, use `MAT_CLAUDE_BIN`/`MAT_CODEX_BIN`/`MAT_NODE_BIN = process.execPath` overrides (unconditional, no probe).
4. Engine adapter contract: completion never rejects; killed = exitCode null + SIGTERM; provider failure = exitCode 1 + error; usage strictly `{inputTokens?, outputTokens?, costUsd?}`.
5. `shared/` schemas additive-only. Never log environment values (fixtures assert presence booleans, never values); every error string passes `redactEnvironmentValues`. Installer writes only under `<dataDir>/runtimes/`.
6. `smoke:browser` stays in the gate (jsdom lies). On this machine run it with
   `CHROME_PATH=/home/ted-h/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`.
7. Windows CI: never assert merged order of events from independent real-time timelines (see `codex-threads.test.ts` fix in `0f57c11`); give worktree/child-spawn integration tests explicit `30_000` timeouts.
8. Leave all changes in the working tree with a report (files, tests run, deviations). Do not commit unless the person driving you explicitly tells you to; commits by Claude end with its Co-Authored-By line, yours should not fake that.

## Acceptance gates for any slice

Server+shared suite green (`npm test`, currently 553 passing / 1 skipped), web suite green (`cd web && npx vitest run`, 164), both typechecks (`npm run typecheck`, `cd web && npx tsc -p tsconfig.json --noEmit`), `smoke:browser` 13/13, real codex+claude smokes when adapter/runtime code changed, `npm run verify:version` before any release commit.
