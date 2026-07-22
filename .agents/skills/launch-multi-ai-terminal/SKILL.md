---
name: launch-multi-ai-terminal
description: Audit, launch, verify, inspect, or stop the local Multi-AI Terminal web server built from this checked-out repository. Use only when the user explicitly asks to run Multi-AI Terminal from source on their local computer.
---

Operate the source-web lane defined by `agent-release.json`. It builds this repository with npm and serves the built web UI from the local MAT server on a loopback port. It is not an installer, release bundle, container, Tauri desktop window, or remote GUI, and it never uses a Rust toolchain.

Source launch executes code from the checked-out repository and its locked JavaScript dependencies. Keep all lifecycle records local. Never read provider credentials, cookies, storage, or profiles, and never drive the launched server's provider install, update, or sign-in APIs on the user's behalf — those actions belong to the user in their own browser.

For an explicit launch request:

1. Confirm the shell runs on the same computer where the user will open their browser; the server binds 127.0.0.1 only. Warn that the launched server uses the normal MAT data directory (`MAT_DATA_DIR` or `~/.multi-ai-terminal`); if the installed MAT desktop app may be running, ask the user to close it first, because two servers over one data directory race its stores.
2. Run `node scripts/agent/audit.mjs --phase before --write --json`.
3. Run `node scripts/agent/doctor.mjs --json`.
4. If prerequisites are missing, report the exact checks and stop. This skill never installs or removes host toolchains, global packages, PATH entries, shell profiles, or security settings. A separate host-change request requires separate explicit approval outside this skill, with exact commands and side effects disclosed first.
5. Run `node scripts/agent/launch.mjs --wait --timeout-ms 600000 --json`. The default `--port 0` picks a free loopback port.
6. Run `node scripts/agent/audit.mjs --phase after --write --json`, including after a launch failure or timeout.
7. Claim readiness only when launch or `node scripts/agent/status.mjs --json --lines 80` reports `state: "ready"`, then report the exact `url` value so the user can open it in their own local browser. "accepted" or "building" does not mean the server is ready.

For status, run `node scripts/agent/status.mjs --json --lines 80`. For an explicit stop request, run `node scripts/agent/stop.mjs --json`. Never stop an unverified process. Use `--clear-invalid-state` only after the user explicitly asks to recover inspected corrupt state; it removes no process.

Never run desktop or Tauri builds for this lane, generate installers, download release assets, upload logs or audits, weaken OS security, delete provider profiles or MAT application data, or automatically roll back/uninstall host software. The shared npm cache and normal MAT app data are user-managed.
