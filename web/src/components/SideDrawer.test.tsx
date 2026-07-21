// @vitest-environment jsdom

import { fireEvent, screen } from '@testing-library/react';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SideDrawer } from './SideDrawer.js';

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function renderHarness(): void {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  function Harness() {
    const [open, setOpen] = useState(false);
    return <>
      <button type="button" onClick={() => setOpen(true)}>Open drawer</button>
      <SideDrawer open={open} title="Test drawer" onClose={() => setOpen(false)}>
        <button type="button">Visible action</button>
        <div hidden><button type="button">Hidden action</button></div>
        <div style={{ display: 'none' }}><button type="button">CSS-hidden action</button></div>
      </SideDrawer>
    </>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  mounted.push({ container, root });
}

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
});

describe('SideDrawer', () => {
  it('traps focus among visible descendants and restores the opener on close', () => {
    renderHarness();
    const opener = screen.getByRole('button', { name: 'Open drawer' });
    opener.focus();
    act(() => fireEvent.click(opener));

    const close = screen.getByRole('button', { name: 'Close Test drawer' });
    const visible = screen.getByRole('button', { name: 'Visible action' });
    expect(document.activeElement).toBe(close);

    act(() => fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }));
    expect(document.activeElement).toBe(visible);
    act(() => fireEvent.keyDown(visible, { key: 'Tab' }));
    expect(document.activeElement).toBe(close);

    act(() => fireEvent.keyDown(close, { key: 'Escape' }));
    expect(screen.queryByRole('dialog', { name: 'Test drawer' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
