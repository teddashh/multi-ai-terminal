import { describe, expect, it } from 'vitest';
import { IncrementalLineBuffer } from '../src/adapters/base.js';

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
