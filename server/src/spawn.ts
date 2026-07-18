import type { ChildProcess } from 'node:child_process';

export interface SpawnProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}
export interface ManagedProcess {
  child: ChildProcess;
  killGroup(signal?: NodeJS.Signals): void;
}
export function spawnManaged(_options: SpawnProcessOptions): ManagedProcess {
  throw new Error('NOT_IMPLEMENTED: spawn');
}
