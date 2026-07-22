export interface TarEntry { path: string; bytes: Buffer; mode: number }

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return Buffer.from(bytes.subarray(0, end < 0 ? bytes.length : end)).toString('utf8');
}

function octal(header: Uint8Array, label: string, fallback?: number): number {
  const text = tarString(header).trim().replace(/^\0+|\0+$/g, '');
  if (!text && fallback !== undefined) return fallback;
  if (!text) throw new Error(`Invalid tar entry ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid tar entry ${label}`);
  return value;
}

function safeSegments(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.startsWith('\\')
    && !/^[A-Za-z]:/.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\'));
}

function walkTar(tarBytes: Uint8Array, visit: (name: string, body: Buffer, mode: number, regular: boolean) => void): void {
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = octal(header.subarray(124, 136), 'size');
    const mode = octal(header.subarray(100, 108), 'mode', 0o644);
    const regular = header[156] === 0 || header[156] === 48;
    offset += 512;
    if (offset + size > tarBytes.length) throw new Error('Truncated tar entry');
    visit(fullName, Buffer.from(tarBytes.subarray(offset, offset + size)), mode, regular);
    offset += Math.ceil(size / 512) * 512;
  }
}

export function readTarEntry(tarBytes: Uint8Array, wantedPath: string): Buffer | null {
  if (!safeSegments(wantedPath)) throw new Error(`Unsafe tar entry path: ${wantedPath}`);
  let found: Buffer | null = null;
  walkTar(tarBytes, (path, bytes, _mode, regular) => {
    if (regular && path === wantedPath) {
      if (!safeSegments(path)) throw new Error(`Unsafe tar entry path: ${path}`);
      found = bytes;
    }
  });
  return found;
}

export function tarEntriesUnder(tarBytes: Uint8Array, prefix: string): TarEntry[] {
  if (!prefix || !prefix.endsWith('/') || prefix.startsWith('/') || prefix.includes('\\')) throw new Error(`Unsafe tar prefix: ${prefix}`);
  const entries: TarEntry[] = [];
  walkTar(tarBytes, (fullPath, bytes, mode, regular) => {
    if (!regular || !fullPath.startsWith(prefix)) return;
    const path = fullPath.slice(prefix.length);
    if (!safeSegments(path)) throw new Error(`Unsafe tar entry path: ${fullPath}`);
    entries.push({ path, bytes, mode });
  });
  return entries;
}
