# Handover — v0.2.10 BAT continuation completion record (2026-07-23)

This note records the completed #24/#25 continuation. Read `HANDOFF.md` and `AGENTS.md` first — they are the canonical repo contract.

## Where the project stands

- **Released: v0.2.10.** The continuation started from v0.2.9 tag commit `0f57c11` / baseline `a77d168` and completed BAT plan #24/#25: Grok/Agy managers, OpenRouter through Codex-as-runtime, the canonical event bridge, and the fifth evidence instrument.
- #23 delivered: codex unified account store (`server/src/providers/codex/accounts.ts` — capture/switch/remove/sync, path-safe ids via shared `CODEX_ACCOUNT_ID_PATTERN`, switch re-snapshots outgoing + re-captures same-target), OpenAI API-key chain (`apiKey.ts`, file 0600 → env; exec env injects file-source only via `codexExecEnv`), needs-login marking wired in `engine/nodeRunner.ts` (suppressed when an API key is configured), sign-in/turn/mutation mutual exclusion (synchronous ceremony reservation in `providers/signin.ts`, reciprocal guard in `nodeRunner`), claude read-only accounts reader, ProviderSetup UI section, HANDOFF §Security 3 updated. All grok-review findings closed (final verdict PASS).
- Deliberately deferred in #23 (do NOT build unless a work order asks): triggering a download from inside sign-in (desktop startup already quietly bootstraps missing supported managed runtimes, with Setup as recovery), native keyring for the API key (file+env is the headless baseline), in-protocol device-code login over app-server RPC (child-process login flow retained).

## Completed work order

### #24 — grok/agy manager pattern + OpenRouter as provider #5 (completed in v0.2.10)
- Grok and Agy were wrapped in the common manager/runtime pattern while preserving their existing headless transports.
- OpenRouter was added as the fifth provider through **codex-as-runtime**, grounded against BAT's unchanged `0e24800` custom-provider precedent.
- `RuntimeFamily` remains `'claude' | 'codex' | 'node'`; Grok, Agy, and OpenRouter are providers, not new runtime families.

### #25 — evidence mapping + canonical event contract (completed in v0.2.10)
- Provider events were mapped through the canonical contract bridge, and the fifth black-box evidence instrument covers the runtime overhaul.

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

For the v0.2.10 #24/#25 release, the recorded local gates are: server+shared suite green (`npm test`, 620 passing / 1 skipped), web suite green (`cd web && npx vitest run`, 180 passing), both typechecks (`npm run typecheck`, `cd web && npx tsc -p tsconfig.json --noEmit`), `smoke:browser` 13/13, `npm run evidence` 5/5, and `npm run verify:version`. Real authenticated codex/claude/OpenRouter smokes still require credentials and isolated test homes; never substitute the user's real provider homes.
