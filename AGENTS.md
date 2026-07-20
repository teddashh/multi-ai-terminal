# Instructions for coding agents

**Read `HANDOFF.md` first** — full project state, architecture map, release playbook, and the history behind every rule below.

## Hard rules

- Provider installs run only from an explicit user click via the fixed recipes in `server/src/providers/install.ts`; user input never reaches a command line; nothing is downloaded implicitly.
- Never log environment-variable values anywhere (diag, errors, bundles, transcripts).
- The `mock` provider stays exempt from real-provider behaviors (spawn stagger, auth alerts) — tests and `tools/evidence/` instruments depend on it.
- `shared/` zod schemas evolve additively only (new fields optional). `server/src/version.ts` must match `server/package.json`.
- Keep the real-browser smoke in CI; jsdom hid a four-release black screen.
- No PTY / interactive-terminal mode; adapters are headless-only.

## Commands

- Build: `npm run build` · Test: `npm test` · Types: `npm run typecheck`
- Browser smoke: `CHROME_PATH=<chromium> npm run smoke:browser`
- Release verifiers: `node tools/evidence/repro-v019.mjs` (see `tools/evidence/README.md`)

## Tests must pass on Windows CI

- Spawn/worktree tests: explicit `, 30_000` timeouts and deadline-based waits.
- Injected path predicates: pure-POSIX fixture paths + fake fs (never `join()` against template-string paths).
- `rmSync` with `maxRetries: 10, retryDelay: 100`.
- Keep the cross-spawn bypass in `server/src/spawn.ts` (`options.shell ? spawnChild : crossSpawn`).
