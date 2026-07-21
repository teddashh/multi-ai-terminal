import { describe, expect, it } from 'vitest';
import { redactEnvironmentValues, redactJsonValue } from '../src/redact.js';

describe('environment-value redaction', () => {
  it('covers ordinary environment names, exact short values, and embedded short credentials', () => {
    const environment = {
      MAT_ORDINARY_MARKER: 'ordinary-value-71e6',
      MAT_SHORT_VALUE: 'q',
      MAT_API_TOKEN: 'xy',
    };
    expect(redactEnvironmentValues('ordinary-value-71e6 / xy / q', environment)).toBe('[REDACTED_ENV] / [REDACTED_ENV] / q');
    expect(redactEnvironmentValues('q', environment)).toBe('[REDACTED_ENV]');
    expect(redactJsonValue({ detail: 'ordinary-value-71e6', version: 'xy' }, environment)).toEqual({
      detail: '[REDACTED_ENV]', version: '[REDACTED_ENV]',
    });
  });
});
