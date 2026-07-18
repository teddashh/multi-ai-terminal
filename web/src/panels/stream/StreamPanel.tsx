import { EventRow, mergeConsecutiveEvents } from '../../components/EventRow.js';
import { useMatStore } from '../../app/store.js';

export function StreamPanel() {
  const activeRunId = useMatStore((state) => state.activeRunId); const events = useMatStore((state) => activeRunId ? state.events[activeRunId] ?? [] : []); const filters = useMatStore((state) => state.filters);
  const visible = mergeConsecutiveEvents(events.filter((event) => filters.roles.includes(event.role) && (filters.nodeRunIds.length === 0 || (event.nodeRunId && filters.nodeRunIds.includes(event.nodeRunId)))));
  return <section className="h-full overflow-auto"><h2 className="sticky top-0 z-10 border-b border-border bg-panel p-3 text-xs font-semibold uppercase tracking-wider text-muted">Event Stream · {events.length}</h2><div>{visible.map((event) => <EventRow key={event.id} event={event} />)}</div>{visible.length === 0 && <p className="p-3 text-xs text-muted">No events to display.</p>}</section>;
}
