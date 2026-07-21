const REDACTED_ENV = '[REDACTED_ENV]';
const SENSITIVE_ENV_NAME = /(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|credential|authorization|private[_-]?key|database[_-]?url|connection[_-]?string|dsn)/i;
const SESSION_CREDENTIAL_ENV_NAME = /(?:^|[_-])(?:cookie|session)(?:$|[_-](?:id|key|secret|token|value))(?:$|[_-])/i;

type Environment = Readonly<Record<string, string | undefined>>;

function environmentValues(environment: Environment): Map<string, boolean> {
  const values = new Map<string, boolean>();
  for (const [name, value] of Object.entries(environment)) {
    if (!value) continue;
    values.set(value, (values.get(value) ?? false) || SENSITIVE_ENV_NAME.test(name) || SESSION_CREDENTIAL_ENV_NAME.test(name));
  }
  return values;
}

/** Values safe to replace as substrings in a streaming sink. */
export function environmentRedactionTokens(environment: Environment = process.env): string[] {
  return [...environmentValues(environment)]
    .filter(([value, sensitiveName]) => value.length >= 8 || sensitiveName)
    .map(([value]) => value)
    .sort((left, right) => right.length - left.length);
}

/**
 * Removes environment-variable values before untrusted text reaches a
 * persistent sink. Callers keep trusted protocol structure out of this
 * function; there is deliberately no field-name allowlist for JSON payloads.
 */
export function redactEnvironmentValues(text: string, environment: Environment = process.env): string {
  const values = environmentValues(environment);

  if (values.has(text)) return REDACTED_ENV;
  let redacted = text;
  for (const value of environmentRedactionTokens(environment)) {
    // Common process metadata often contains protocol words such as "user" or
    // "cat". Only sufficiently distinctive ordinary values are safe for blind
    // substring replacement. Credentials receive no length exception, and any
    // ordinary value is still removed when it is the whole field above.
    redacted = redacted.split(value).join(REDACTED_ENV);
  }
  return redacted;
}

export function redactDiagnosticValue(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? redactEnvironmentValues(value) : value;
}

/** Redacts every string in JSON-shaped evidence while preserving its shape. */
export function redactJsonValue<T>(value: T, environment: Environment = process.env): T {
  if (typeof value === 'string') return redactEnvironmentValues(value, environment) as T;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, environment)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redactJsonValue(item, environment)])) as T;
  }
  return value;
}
