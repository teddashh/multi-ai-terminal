import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useUiPreferences } from '../i18n/UiPreferences.js';

export interface SideDrawerProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SideDrawer({ open, title, onClose, children, footer, widthClassName = 'max-w-xl' }: SideDrawerProps) {
  const { t } = useUiPreferences();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      const focusable = [...(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((element) => panel !== null && isVisibleWithin(element, panel));
      if (focusable.length === 0) { event.preventDefault(); return; }
      const first = focusable[0]!; const last = focusable.at(-1)!;
      if (!panel?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previouslyFocused?.focus(); };
  }, [open]);

  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`flex h-full w-full flex-col border-l border-border bg-panel shadow-2xl ${widthClassName}`}>
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 id={titleId} className="font-semibold text-ink">{title}</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label={t('common.closeNamed', { title })} className="rounded px-2 py-1 text-muted hover:bg-raised hover:text-ink">×</button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      {footer && <footer className="shrink-0 border-t border-border px-4 py-3">{footer}</footer>}
    </section>
  </div>;
}

function isVisibleWithin(element: HTMLElement, panel: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current && panel.contains(current); current = current.parentElement) {
    if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}
