import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function createFakeExecutable(directory: string, name: string, source: string): string {
  if (process.platform === 'win32') {
    const script = join(directory, `${name}.fake.cjs`);
    const executable = join(directory, `${name}.cmd`);
    writeFileSync(script, source, 'utf8');
    writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    return executable;
  }

  const executable = join(directory, name);
  writeFileSync(executable, `#!/usr/bin/env node\n${source}`, 'utf8');
  chmodSync(executable, 0o755);
  return executable;
}

export function prependPath(directory: string, current = process.env.PATH): string {
  return [directory, current].filter((entry): entry is string => Boolean(entry)).join(delimiter);
}
