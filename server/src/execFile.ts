import crossSpawn from 'cross-spawn';

interface ExecFileOptions {
  cwd?: string;
  maxBuffer?: number;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export function execFile(command: string, args: string[], options: ExecFileOptions = {}): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const maxBuffer = options.maxBuffer ?? Number.POSITIVE_INFINITY;
    let stdout = '';
    let stderr = '';
    let size = 0;
    let settled = false;
    const fail = (error: Error & { code?: string | number | null }): void => {
      if (settled) return;
      settled = true;
      reject(Object.assign(error, { stdout, stderr }));
    };
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBuffer) {
        child.kill();
        fail(Object.assign(new Error(`Command output exceeded ${maxBuffer} bytes: ${command}`), { code: 'ENOBUFS' }));
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error) => fail(error));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(
        new Error(`Command failed with exit code ${code}: ${command}`),
        { code, signal, stdout, stderr },
      ));
    });
  });
}
