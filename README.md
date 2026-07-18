# Multi-AI Terminal

Multi-AI Terminal is a local web workbench for composing and running workflows across headless CLI coding agents. It normalizes each agent's output into one replayable event stream.

Requirements: Node.js 20+ and Git 2.32 or newer are recommended. Older Git versions are supported with a plain `git apply --check` fallback when `--check --3way` is unavailable.

```sh
npm install
npm run dev
npm run build
npm start
```

See [SPEC.md](./SPEC.md) for the product and engineering contract.

Known limitation: after a machine reboot, crash recovery identifies stale process groups from persisted PIDs. PID recycling risk is accepted for v1.
