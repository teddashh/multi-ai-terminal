import type { Adapter, AdapterContentEvent, NodeOutcome, ResolvedNodeSpec, SpawnedNode } from './base.js';

const scriptedEvents: AdapterContentEvent[] = [
  { role: 'thinking', kind: 'thinking', text: 'Considering the task.' },
  { role: 'tool', kind: 'tool_use', text: 'Using mock_tool', tool: { toolCallId: 'mock-1', name: 'mock_tool', input: '{"task":"demo"}' } },
  { role: 'tool', kind: 'tool_result', text: 'mock_tool completed', tool: { toolCallId: 'mock-1', name: 'mock_tool', output: 'ok' } },
  { role: 'agent', kind: 'message', text: 'Mock task completed.' },
];

export const mockAdapter: Adapter = {
  id: 'mock', tier: 'rich', models: ['ok', 'fail', 'slow:<ms>', 'noisy'], defaultModel: 'ok',
  async available() { return { ok: true, version: 'builtin' }; },
  spawn(spec, io): SpawnedNode {
    const model = spec.binding.model ?? 'ok';
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveCompletion!: (outcome: NodeOutcome) => void;
    const completion = new Promise<NodeOutcome>((resolve) => { resolveCompletion = resolve; });
    const delay = model.startsWith('slow:') ? Math.max(0, Number(model.slice(5)) || 0) : 0;
    const events = model === 'noisy'
      ? Array.from({ length: 40 }, (_, index): AdapterContentEvent => ({ role: 'agent', kind: 'message', text: `chunk-${index} ` }))
      : scriptedEvents;

    const finish = (outcome: NodeOutcome): void => {
      if (timer) clearTimeout(timer);
      resolveCompletion(outcome);
    };
    const run = (index = 0): void => {
      if (killed) return;
      if (model === 'fail') {
        io.onRaw('mock failure', 'err');
        finish({ exitCode: 1, error: 'mock failure' });
        return;
      }
      if (index >= events.length) {
        const resultText = model === 'noisy' ? events.map((event) => event.text).join('') : 'Mock task completed.';
        finish({ exitCode: 0, resultText });
        return;
      }
      const event = events[index]!;
      io.onRaw(JSON.stringify(event), 'out');
      io.onEvent(event);
      timer = setTimeout(() => run(index + 1), delay);
    };
    queueMicrotask(() => run());

    return {
      pid: process.pid,
      kill(signal = 'SIGTERM') {
        if (killed) return;
        killed = true;
        finish({ exitCode: null, signal, error: 'killed' });
      },
      completion,
    };
  },
};

export default mockAdapter;
