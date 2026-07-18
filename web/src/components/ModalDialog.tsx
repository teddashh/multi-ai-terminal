import { useEffect, type ReactNode } from 'react';

export interface ModalDialogProps { open: boolean; title: string; onClose(): void; children: ReactNode; footer?: ReactNode }
export function ModalDialog({ open, title, onClose, children, footer }: ModalDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="modal-title" className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border border-border bg-panel shadow-2xl">
      <header className="flex items-center justify-between border-b border-border px-4 py-3"><h2 id="modal-title" className="font-semibold text-ink">{title}</h2><button type="button" onClick={onClose} aria-label="Close dialog" className="rounded px-2 py-1 text-muted hover:bg-zinc-800 hover:text-ink">×</button></header>
      <div className="p-4">{children}</div>{footer && <footer className="border-t border-border px-4 py-3">{footer}</footer>}
    </section>
  </div>;
}
