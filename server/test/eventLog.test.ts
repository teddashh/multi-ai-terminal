import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventLog } from '../src/store/eventLog.js';

const dirs: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

const partial = (runId: string, text: string) => ({ runId, stageId: null, nodeRunId: null, attempt: 0, role: 'system' as const, kind: 'status' as const, text });

describe('EventLog', () => {
  it('assigns identity, writes before notifying, and pages after seq', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mat-event-log-')); dirs.push(dir);
    const log = new EventLog(dir);
    let persistedAtNotify = false;
    log.subscribe((event) => { persistedAtNotify = readFileSync(log.pathFor('r1'), 'utf8').includes(event.id); });
    expect(log.appendEvent('r1', partial('r1', 'one')).seq).toBe(1);
    expect(log.appendEvent('r1', partial('r1', 'two')).seq).toBe(2);
    expect(log.appendEvent('r1', partial('r1', 'three')).seq).toBe(3);
    expect(persistedAtNotify).toBe(true);
    expect(log.afterSeq('r1', 1, 1).map((event) => event.text)).toEqual(['two']);
    expect(log.afterSeq('r1', 2, 10).map((event) => event.text)).toEqual(['three']);
  });

  it('recovers the next sequence from the last line on a new instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mat-event-log-')); dirs.push(dir);
    new EventLog(dir).appendEvent('r1', partial('r1', 'one'));
    new EventLog(dir).appendEvent('r1', partial('r1', 'two'));
    expect(new EventLog(dir).appendEvent('r1', partial('r1', 'three')).seq).toBe(3);
  });

  it('truncates a torn final fragment before the next append', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mat-event-log-')); dirs.push(dir);
    const first = new EventLog(dir);
    first.appendEvent('r1', partial('r1', 'one'));
    appendFileSync(first.pathFor('r1'), '{"id":"torn"', 'utf8');
    expect(new EventLog(dir).appendEvent('r1', partial('r1', 'two')).seq).toBe(2);
    const lines = readFileSync(first.pathFor('r1'), 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([1, 2]);
  });

  it('redacts environment values from every JSON-shaped transcript field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mat-event-log-')); dirs.push(dir);
    const sentinel = 'event-env-sentinel-98a72f';
    const previous = process.env.MAT_TEST_EVENT_SECRET;
    const previousProtocol = process.env.MAT_TEST_PROTOCOL_SECRET;
    process.env.MAT_TEST_EVENT_SECRET = sentinel;
    process.env.MAT_TEST_PROTOCOL_SECRET = 'user';
    try {
      const log = new EventLog(dir);
      const saved = log.appendEvent('r1', {
        ...partial('r1', `message ${sentinel}`),
        role: 'user',
        tool: { name: 'shell', input: sentinel },
        data: { detail: 'user', nested: { value: sentinel } },
      });
      const persisted = readFileSync(log.pathFor('r1'), 'utf8');
      expect(JSON.stringify(saved)).not.toContain(sentinel);
      expect(persisted).not.toContain(sentinel);
      expect(saved).toMatchObject({
        text: 'message [REDACTED_ENV]',
        role: 'user',
        tool: { input: '[REDACTED_ENV]' },
        data: { detail: '[REDACTED_ENV]', nested: { value: '[REDACTED_ENV]' } },
      });
      const trusted = log.appendEvent('r2', {
        ...partial('r2', `message ${sentinel}`),
        data: { detail: 'user', nested: { value: '[REDACTED_ENV]' } },
      }, { trustedData: true });
      expect(trusted).toMatchObject({
        text: 'message [REDACTED_ENV]',
        data: { detail: 'user', nested: { value: '[REDACTED_ENV]' } },
      });
    } finally {
      if (previous === undefined) delete process.env.MAT_TEST_EVENT_SECRET;
      else process.env.MAT_TEST_EVENT_SECRET = previous;
      if (previousProtocol === undefined) delete process.env.MAT_TEST_PROTOCOL_SECRET;
      else process.env.MAT_TEST_PROTOCOL_SECRET = previousProtocol;
    }
  });

  it('pages across sparse byte-index checkpoints and indexes later appends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mat-event-index-')); dirs.push(dir);
    const log = new EventLog(dir);
    for (let seq = 1; seq <= 1_550; seq += 1) log.appendEvent('r1', partial('r1', `event-${seq}`));
    expect(log.afterSeq('r1', 510, 5).map((event) => event.seq)).toEqual([511, 512, 513, 514, 515]);
    expect(log.afterSeq('r1', 1_025, 4).map((event) => event.seq)).toEqual([1_026, 1_027, 1_028, 1_029]);
    expect(log.afterSeq('r1', 1_548, 10).map((event) => event.seq)).toEqual([1_549, 1_550]);
    expect(log.appendEvent('r1', partial('r1', 'later')).seq).toBe(1_551);
    expect(log.afterSeq('r1', 1_550, 10).map((event) => event.text)).toEqual(['later']);
  });
});
