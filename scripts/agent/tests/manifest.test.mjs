import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { expect, test } from 'vitest';
import { manifest, readyMarker, resolveRepoPath, root } from '../contract.mjs';

test('agent release manifest validates against its schema', () => {
  const schema = readJson(path.join(root, 'agent-release.schema.json'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addFormat('uri', {
    type: 'string',
    validate(value) {
      try {
        return Boolean(new URL(value));
      } catch {
        return false;
      }
    },
  });
  const validate = ajv.compile(schema);
  expect(validate(manifest), JSON.stringify(validate.errors, null, 2)).toBe(true);
});

test('manifest entrypoints exist and stay aligned with package scripts', () => {
  const packageJson = readJson(path.join(root, 'package.json'));
  for (const [name, entrypoint] of Object.entries(manifest.entrypoints)) {
    expect(entrypoint.argv[0]).toBe('node');
    expect(existsSync(path.join(root, entrypoint.argv[1])), `${name} entrypoint is missing`).toBe(true);
    expect(packageJson.scripts[`agent:${name}`]).toBe(entrypoint.argv.join(' '));
  }
  expect(packageJson.scripts['test:agent']).toBe('vitest run scripts/agent/tests');
});

test('codex and Claude skills share one maintained instruction body', () => {
  const codexSkill = parseSkill(readFileSync(path.join(root, manifest.skills.codex), 'utf8'));
  const claudeSkill = parseSkill(readFileSync(path.join(root, manifest.skills.claude), 'utf8'));
  const codexMetadata = readFileSync(path.join(root, manifest.skills.codexMetadata), 'utf8');

  expect(codexSkill.body).toBe(claudeSkill.body);
  expect(codexSkill.frontmatter).toMatch(/name:\s*launch-multi-ai-terminal/);
  expect(codexSkill.frontmatter).not.toMatch(/disable-model-invocation/);
  expect(claudeSkill.frontmatter).toMatch(/name:\s*launch-multi-ai-terminal/);
  expect(claudeSkill.frontmatter).toMatch(/disable-model-invocation:\s*true/);
  expect(codexMetadata).toMatch(/allow_implicit_invocation:\s*false/);
  expect(manifest.skills.implicitInvocation).toBe(false);
  expect(manifest.skills.version).toBe(manifest.contractVersion);
});

test('contract declares explicit trust and host-change boundaries', () => {
  expect(manifest.trust.invocation).toBe('explicit-only');
  expect(manifest.trust.warning).toMatch(/No Rust toolchain/);
  expect(manifest.permissions.requiresSeparateExplicitApproval.some((item) => item.includes('host toolchains'))).toBe(true);
  expect(manifest.permissions.requiresSeparateExplicitApproval.some((item) => item.includes('PATH'))).toBe(true);
  expect(manifest.permissions.deniedBySkill.some((item) => item.includes('automatic host rollback'))).toBe(true);
  expect(manifest.permissions.deniedBySkill.some((item) => item.includes("provider install, update, or sign-in APIs"))).toBe(true);
  expect(manifest.sideEffects.hostConfigurationByScripts.startsWith('none')).toBe(true);
  expect(manifest.privacy.localOnly).toBe(true);
  expect(manifest.privacy.credentials).toMatch(/never read/);
  expect(manifest.entrypoints.stop.flags).toContain('--clear-invalid-state');
  for (const effect of manifest.sideEffects.repositoryLocal) {
    expect(effect.evidence.length).toBeGreaterThan(0);
    for (const evidencePath of effect.evidence) {
      const relative = path.relative(path.join(root, effect.path), path.join(root, evidencePath));
      expect(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))).toBe(true);
    }
  }
});

test('runtime contract matches the lifecycle implementation', () => {
  expect(manifest.runtime.states).toEqual([
    'not_started',
    'building',
    'ready',
    'failed',
    'exited',
    'invalid_state',
    'foreign_process',
  ]);
  expect(Object.keys(manifest.exitCodes).sort()).toEqual(['0', '1', '2', '3']);
  expect(readyMarker).toBe('[MAT_AGENT] READY');
  expect(manifest.runtime.launchLock).toBe('.agent-runtime/launch.lock');
  // audit-model.mjs hardcodes these two paths in its receipt validation.
  expect(manifest.runtime.stateFile).toBe('.agent-runtime/mat-server.json');
  expect(manifest.runtime.logFile).toBe('.agent-runtime/mat-server.log');
  expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toMatch(/^\.agent-runtime\/$/m);
});

test('repository paths from the manifest cannot escape the repository', () => {
  expect(resolveRepoPath('.agent-runtime')).toBe(path.join(root, '.agent-runtime'));
  expect(() => resolveRepoPath(path.join('..', 'outside'))).toThrow(/escapes repository/);
});

test('lifecycle scripts contain no host package-manager or privilege escalation command', () => {
  const lifecycleFiles = [
    'contract.mjs',
    'windows-command.mjs',
    'process-identity.mjs',
    'environment.mjs',
    'runner.mjs',
    'runtime-status.mjs',
    'audit-model.mjs',
    'doctor.mjs',
    'audit.mjs',
    'launch.mjs',
    'status.mjs',
    'stop.mjs',
  ];
  const forbidden = /(?:winget\s+install|brew\s+install|apt(?:-get)?\s+install|rustup\s+install|npm\s+(?:install|i)\s+(?:--global|-g)|pnpm\s+(?:add|install)\s+(?:--global|-g)|\bsudo\b|Start-Process\s+[^\n]*-Verb\s+RunAs)/i;
  for (const file of lifecycleFiles) {
    const source = readFileSync(path.join(root, 'scripts', 'agent', file), 'utf8');
    expect(source, `${file} must not mutate host prerequisites`).not.toMatch(forbidden);
  }
});

function parseSkill(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  expect(match, 'SKILL.md must contain YAML frontmatter').toBeTruthy();
  return { frontmatter: match[1], body: match[2].trim() };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}
