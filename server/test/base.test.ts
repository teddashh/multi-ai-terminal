import { describe, expect, it } from 'vitest';
import { humanizeError, IncrementalLineBuffer } from '../src/adapters/base.js';

describe('IncrementalLineBuffer', () => {
  it('handles partial lines and flushes the tail', () => {
    const lines: string[] = [];
    const buffer = new IncrementalLineBuffer((line) => lines.push(line));
    buffer.push('hel'); buffer.push('lo\nwor'); buffer.end();
    expect(lines).toEqual(['hello', 'wor']);
  });
  it('handles multiline chunks, blank lines, and CRLF', () => {
    const lines: string[] = [];
    const buffer = new IncrementalLineBuffer((line) => lines.push(line));
    buffer.push('one\r\ntwo\n\nthree\r\n'); buffer.end();
    expect(lines).toEqual(['one', 'two', '', 'three']);
  });
});

describe('humanizeError', () => {
  it('turns missing CLI spawn errors into an actionable instruction', () => {
    expect(humanizeError('spawn grok ENOENT')).toBe('`grok` CLI not found on PATH — install it or remove this agent from the workflow.');
  });

  it('unwraps double-encoded Codex API failures', () => {
    const nested = JSON.stringify({ message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'Unsupported input.' } }) });
    expect(humanizeError(nested, 'codex')).toBe('codex: 400 invalid_request_error — Unsupported input.');
  });

  it('passes plain text through unchanged', () => {
    expect(humanizeError('plain failure')).toBe('plain failure');
  });
});
