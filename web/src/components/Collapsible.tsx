import type { ReactNode } from 'react';

export function Collapsible({ summary, children, defaultOpen = false, className = '' }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  return <details className={className} open={defaultOpen}><summary className="cursor-pointer list-none select-none marker:hidden">{summary}</summary><div className="mt-2">{children}</div></details>;
}
