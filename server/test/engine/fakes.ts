import type { RunSnapshot } from '@mat/shared';

export async function waitForRun(
  read: () => RunSnapshot | undefined,
  predicate: (run: RunSnapshot) => boolean,
  timeoutMs = 3000,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = read();
    if (run && predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for synthetic run state');
}
