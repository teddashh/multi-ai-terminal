# Evidence instruments

Independent black-box verifiers, deliberately separate from the vitest suites. Each boots a built server (`server/dist/index.js`) on its own port with a throwaway data directory and temp git workspace, drives it purely over HTTP, and asserts observable behavior — including against an extracted release artifact, which is how every release since v0.1.6 has been verified before its final report.

| Script | Guards (introduced in) |
| --- | --- |
| `repro-v016.mjs` | Evidence plane: verification contracts, requireVerified gating, handoff capture, run report (v0.1.6) |
| `repro-v017.mjs` | Steering: interrupt kill/redo with preserved partial evidence, queue mode, review decisions; debug bundle zip contents; client-log → server journal (v0.1.7) |
| `repro-v018.mjs` | Provider onboarding: augmented-PATH discovery (fake HOME with an `agy` stub), providers contract (`installable`/`manualCommand`/failure `detail`), install-endpoint guards, mock exempt from spawn stagger (v0.1.8) |
| `repro-v019.mjs` | Auth visibility: sign-in commands advertised per provider, no alerts on fresh boot, `MOCK_AUTHFAIL` keeps mock exempt from auth reasons/alerts while the CLI text stays in the transcript and report (v0.1.9) |

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

`run-all.mjs` runs every instrument and reports a final per-script summary. A
single instrument can still be run directly while developing it. `repro-v018`
uses an isolated PATH with deterministic `agy` and failing-`grok` stubs, so its
result does not depend on real provider CLIs installed on the host.

The complete suite currently targets Linux/POSIX because its release-acceptance
path verifies an extracted `.deb` and v018 uses executable stubs. Windows CI
continues to exercise the same product boundaries through Vitest and the real
browser smoke; it does not run `npm run evidence`.

Environment:

- `MAT_ROOT` — directory containing `server/dist/index.js` (defaults to this repo).
- `MAT_REPO` — repo root used to resolve devDependencies the shipped artifact lacks (adm-zip in `repro-v017`); defaults to this repo.
- `MAT_EXPECT_VERSION` — expected `/api/health` version where a script asserts it (`repro-v018`, `repro-v019`); older scripts are version-agnostic.
- `MAT_PORT` — override the per-script default port (7813/7815/7816/7817).

Exit code 0 means every check passed; failures are listed at the end of the output.
