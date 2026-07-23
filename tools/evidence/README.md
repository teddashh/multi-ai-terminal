# Evidence instruments

Independent black-box verifiers, deliberately separate from the vitest suites. Each boots a built server (`server/dist/index.js`) on an OS-assigned loopback port with a throwaway data directory and temp git workspace, accepts readiness only from its own child process, drives it purely over timeout-bounded HTTP, and asserts observable behavior — including against an extracted release artifact, which is how every release since v0.1.6 has been verified before its final report.

| Script | Guards (introduced in) |
| --- | --- |
| `repro-v016.mjs` | Evidence plane: verification contracts, requireVerified gating, handoff capture, run report (v0.1.6) |
| `repro-v017.mjs` | Steering: interrupt kill/redo with preserved partial evidence, queue mode, review decisions; debug bundle zip contents; client-log → server journal (v0.1.7) |
| `repro-v018.mjs` | Provider onboarding: augmented-PATH discovery (fake HOME with an `agy` stub), providers contract (`installable`/`manualCommand`/failure `detail`), install-endpoint guards, mock exempt from spawn stagger (v0.1.8) |
| `repro-v019.mjs` | Auth visibility: sign-in commands advertised per provider, no alerts on fresh boot, `MOCK_AUTHFAIL` keeps mock exempt from auth reasons/alerts while the CLI text stays in the transcript and report (v0.1.9) |
| `repro-runtime-contract.mjs` | Canonical provider-event evidence: a Node-core fake codex app-server drives OpenRouter through exact model/provider routing, thinking + Bash tool + answer mapping, usage/session capture, one terminal contract marker, environment redaction, and byte-equivalent replay after server restart |

## Running

Run the complete suite against the working tree (after `npm run build`):

```sh
npm run evidence
```

Against an extracted release (deb example):

```sh
dpkg-deb -x Multi-AI.Terminal_<version>_amd64.deb extracted
MAT_ROOT="extracted/usr/lib/Multi-AI Terminal" \
MAT_EXPECT_VERSION=<version> \
npm run evidence
```

`run-all.mjs` runs every instrument under a throwaway HOME/config tree, a
provider-free PATH, and a credential-free allowlisted environment, then reports
a final per-script summary. A single instrument can still be run directly while
developing it. `repro-v018`
uses an isolated PATH with deterministic `agy` and failing-`grok` stubs, so its
result does not depend on real provider CLIs installed on the host.
`repro-runtime-contract` likewise uses throwaway HOME, CODEX_HOME, data, and
workspace directories plus an isolated PATH and fake codex app-server. A fixed
non-secret canary passes through provider content, tool output, and stderr to
prove environment redaction in durable and log sinks. It performs no
provider-network request and never reads a real credential store.

The complete suite currently targets Linux/POSIX because its release-acceptance
path verifies an extracted `.deb` and v018 uses executable stubs. Windows CI
continues to exercise the same product boundaries through Vitest and the real
browser smoke; it does not run `npm run evidence`.

Environment:

- `MAT_ROOT` — directory containing `server/dist/index.js` (defaults to this repo).
- `MAT_REPO` — repo root used to resolve devDependencies the shipped artifact lacks (adm-zip in `repro-v017`); defaults to this repo.
- `MAT_EXPECT_VERSION` — expected `/api/health` version where a script asserts it (`repro-v018`, `repro-v019`, `repro-runtime-contract`); older scripts are version-agnostic.
- `MAT_PORT` — optional fixed-port override; every instrument defaults to an OS-assigned port.

Exit code 0 means every check passed; failures are listed at the end of the output.
