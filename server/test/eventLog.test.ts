import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventLog } from '../src/store/eventLog.js';

const dirs: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
});
