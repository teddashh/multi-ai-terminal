import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tauriRoot = new URL('../src-tauri/', import.meta.url);
const capability = JSON.parse(readFileSync(new URL('capabilities/default.json', tauriRoot), 'utf8'));
const cargoToml = readFileSync(new URL('Cargo.toml', tauriRoot), 'utf8');
const mainRs = readFileSync(new URL('src/main.rs', tauriRoot), 'utf8');

describe('Tauri folder-picker integration', () => {
  it('registers the plugin in Cargo and the Tauri builder', () => {
    expect(cargoToml).toMatch(/^tauri-plugin-dialog\s*=\s*"2"$/m);
    expect(mainRs).toContain('.plugin(tauri_plugin_dialog::init())');
  });

  it('grants only open-dialog access to the loopback-hosted main UI', () => {
    expect(capability.windows).toContain('main');
    expect(capability.local).toBe(false);
    expect(capability.remote?.urls).toContain('http://127.0.0.1:*/*');
    expect(capability.permissions).toEqual(['dialog:allow-open']);
  });
});
