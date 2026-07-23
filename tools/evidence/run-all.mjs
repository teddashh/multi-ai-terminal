#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedServerEnvironment } from './harness.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.MAT_ROOT ?? REPO_ROOT;
const VERSION = process.env.MAT_EXPECT_VERSION
  ?? JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const instruments = [
  'repro-v016.mjs',
  'repro-v017.mjs',
  'repro-v018.mjs',
  'repro-v019.mjs',
  'repro-runtime-contract.mjs',
];

if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) {
  console.error(`[evidence] FAIL: ${join(ROOT, 'server', 'dist', 'index.js')} is missing; build or extract the artifact first`);
  process.exit(1);
}

// The complete release verifier must not inherit a developer's credentials,
// config homes, provider binaries, proxy hooks, or NODE_OPTIONS. Older
// instruments intentionally inherit this controlled baseline, while newer
// ones narrow it further for their own fake runtimes.
const harnessRoot = mkdtempSync(join(tmpdir(), 'mat-evidence-suite-'));
const evidenceEnv = {
  ...isolatedServerEnvironment({
    harnessRoot,
    dataDir: join(harnessRoot, 'data'),
    port: Number(process.env.MAT_PORT ?? 0),
  }),
  MAT_ROOT: ROOT,
  MAT_REPO: process.env.MAT_REPO ?? REPO_ROOT,
  MAT_EXPECT_VERSION: VERSION,
};

const results = [];
let cleanupFailed = false;
try {
  for (const instrument of instruments) {
    console.log(`\n[evidence] RUN ${instrument} (expecting ${VERSION})`);
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(REPO_ROOT, 'tools', 'evidence', instrument)], {
        env: evidenceEnv,
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', (error) => {
        console.error(`[evidence] ${instrument} could not start: ${error instanceof Error ? error.message : String(error)}`);
        resolve(1);
      });
      child.once('close', (exitCode) => resolve(exitCode ?? 1));
    });
    results.push({ instrument, code });
  }
} finally {
  try {
    rmSync(harnessRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    cleanupFailed = true;
    console.error(`[evidence] harness cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const failed = results.filter((result) => result.code !== 0);
console.log(`\n[evidence] ${failed.length === 0 && !cleanupFailed ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} instruments passed`);
for (const result of results) console.log(`[evidence] ${result.code === 0 ? 'PASS' : 'FAIL'} ${result.instrument}`);
process.exitCode = failed.length === 0 && !cleanupFailed ? 0 : 1;
