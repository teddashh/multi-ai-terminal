// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AiSisterAvatar } from './AiSisterTheme.js';

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function render(element: Parameters<Root['render']>[0]): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

afterEach(() => mounted.splice(0).forEach(({ root, container }) => { act(() => root.unmount()); container.remove(); }));

describe('AiSisterAvatar', () => {
  it.each([
    ['claude', 'claude.webp'],
    ['codex', 'chatgpt.webp'],
    ['agy', 'gemini.webp'],
    ['grok', 'grok.webp'],
  ])('maps provider %s to %s behind the theme gate', (provider, asset) => {
    const container = render(<AiSisterAvatar provider={provider} />);
    const wrapper = container.querySelector('span');
    expect(wrapper?.classList.contains('ai-sister-only')).toBe(true);
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('img')?.getAttribute('src')).toContain(asset);
  });

  it.each(['mock', 'unknown'])('renders nothing for provider %s', (provider) => {
    expect(render(<AiSisterAvatar provider={provider} />).innerHTML).toBe('');
  });
});
