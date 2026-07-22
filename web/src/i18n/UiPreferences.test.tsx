// @vitest-environment jsdom

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InterfacePreferences, loadUiPreferences, resolveLocale, UiPreferencesProvider, useUiPreferences } from './UiPreferences.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function Probe() {
  const { t } = useUiPreferences();
  return <><span>{t('app.health')}</span><InterfacePreferences /></>;
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'languages', { configurable: true, value: ['zh-TW', 'zh'] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.lang = '';
});

describe('UI preferences', () => {
  it('maps Chinese system locales to zh-TW and other locales to English', () => {
    expect(resolveLocale('system', ['zh-Hant-TW'])).toBe('zh-TW');
    expect(resolveLocale('system', ['en-US'])).toBe('en');
    expect(resolveLocale('system', ['en-US', 'zh-TW'])).toBe('en');
    expect(resolveLocale('en', ['zh-TW'])).toBe('en');
  });

  it('starts in system Traditional Chinese and persists AI-Sister theme choices', async () => {
    act(() => root?.render(<UiPreferencesProvider><Probe /></UiPreferencesProvider>));

    expect(screen.getByText('健康狀態')).toBeTruthy();
    expect(screen.getByText('語言・主題')).toBeTruthy();
    expect(document.documentElement.lang).toBe('zh-TW');

    act(() => fireEvent.change(screen.getByLabelText('介面主題'), { target: { value: 'ai-sister' } }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('ai-sister'));
    expect(screen.getByText('AI-Sister 最終紀念版')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('mat-ui-preferences-v1') ?? '{}')).toMatchObject({ language: 'system', theme: 'ai-sister' });

    act(() => fireEvent.change(screen.getByLabelText('介面語言'), { target: { value: 'en' } }));
    await waitFor(() => expect(screen.getByText('Health')).toBeTruthy());
    expect(document.documentElement.lang).toBe('en');
    expect(JSON.parse(localStorage.getItem('mat-ui-preferences-v1') ?? '{}')).toMatchObject({ language: 'en', theme: 'ai-sister' });
  });

  it('migrates the legacy aurora preference to AI-Sister and rewrites storage', () => {
    localStorage.setItem('mat-ui-preferences-v1', JSON.stringify({ language: 'en', theme: 'aurora' }));
    expect(loadUiPreferences()).toEqual({ language: 'en', theme: 'ai-sister' });
    expect(JSON.parse(localStorage.getItem('mat-ui-preferences-v1') ?? '{}')).toEqual({ language: 'en', theme: 'ai-sister' });
  });

  it('ignores malformed persisted preferences', () => {
    localStorage.setItem('mat-ui-preferences-v1', JSON.stringify({ language: 'xx', theme: 'neon' }));
    expect(loadUiPreferences()).toEqual({ language: 'system', theme: 'dark' });
  });
});
