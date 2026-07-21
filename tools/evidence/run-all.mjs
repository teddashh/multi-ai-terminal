#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.MAT_ROOT ?? REPO_ROOT;
const VERSION = process.env.MAT_EXPECT_VERSION
  ?? JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const instruments = ['repro-v016.mjs', 'repro-v017.mjs', 'repro-v018.mjs', 'repro-v019.mjs'];

if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) {
  console.error(`[evidence] FAIL: ${join(ROOT, 'server', 'dist', 'index.js')} is missing; build or extract the artifact first`);
  process.exit(1);
}

const results = [];
for (const instrument of instruments) {
  console.log(`\n[evidence] RUN ${instrument} (expecting ${VERSION})`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'tools', 'evidence', instrument)], {
      env: { ...process.env, MAT_ROOT: ROOT, MAT_EXPECT_VERSION: VERSION },
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

const failed = results.filter((result) => result.code !== 0);
console.log(`\n[evidence] ${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} instruments passed`);
for (const result of results) console.log(`[evidence] ${result.code === 0 ? 'PASS' : 'FAIL'} ${result.instrument}`);
process.exitCode = failed.length === 0 ? 0 : 1;
