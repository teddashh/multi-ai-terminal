# Instructions for coding agents

**Read `HANDOFF.md` first** — full project state, architecture map, release playbook, and the history behind every rule below.

## Hard rules

- Preserve the BAT-style smooth first run: the desktop quietly bootstraps missing catalog-pinned, integrity-verified Claude/Codex managed runtimes under `<dataDir>/runtimes/` through the single server coordinator; the web client must not start a duplicate installer. Do not replace this with a user-visible flag, per-provider confirmation, or repeated Setup flow. Provider-specific recipes, updates, and sign-in remain fixed product actions; user input never reaches a command line, and MAT never performs a host-global install or edits `PATH`.
- Never log values read from the environment (diag, errors, bundles, transcripts); use the source-aware sink policy in `server/src/redact.ts`, preserving only trusted engine/protocol structure.
- The `mock` provider stays exempt from real-provider behaviors (spawn stagger, auth alerts) — tests and `tools/evidence/` instruments depend on it.
- `shared/` zod schemas evolve additively only (new fields optional). `server/src/version.ts` must match `server/package.json`.
- Keep the real-browser smoke in CI; jsdom hid a four-release black screen.
- No PTY / interactive-terminal mode; adapters are headless-only.

## Commands

- Versions: `npm run verify:version` · Build: `npm run build` · Test: `npm test` · Types: `npm run typecheck`
- Browser smoke: `CHROME_PATH=<chromium> npm run smoke:browser`
- Evidence/release verifiers after build: `npm run evidence` (see `tools/evidence/README.md`)

## Tests must pass on Windows CI

- Spawn/worktree tests: explicit `, 30_000` timeouts and deadline-based waits.
- Injected path predicates: pure-POSIX fixture paths + fake fs (never `join()` against template-string paths).
- Compare workspace paths to the canonical store/API value; fixture repos that assert patch bytes set local `core.autocrlf=false`.
- `rmSync` with `maxRetries: 10, retryDelay: 100`.
- Keep the cross-spawn bypass in `server/src/spawn.ts` (`options.shell ? spawnChild : crossSpawn`).
