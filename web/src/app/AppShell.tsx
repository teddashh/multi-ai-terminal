import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { RunPanel } from '../panels/run/RunPanel.js';
import { WorkflowPanel } from '../panels/workflow/WorkflowPanel.js';
import { WorkspacePanel } from '../panels/workspace/WorkspacePanel.js';
import { useUiPreferences } from '../i18n/UiPreferences.js';
import { RunWorkspace } from './RunWorkspace.js';

const LAYOUT_KEY = 'mat-shell-layout-v2';
const DEFAULT_LAYOUT = { launchpadWidth: 320, inspectorWidth: 280 } as const;
const MIN_LAYOUT = { launchpadWidth: 280, inspectorWidth: 260 } as const;
const MAX_LAYOUT = { launchpadWidth: 520, inspectorWidth: 520 } as const;
const RAIL_WIDTH = 84;
const DIVIDER_WIDTH = 5;
const MIN_WORKSPACE_WIDTH = 320;

type LaunchpadView = 'projects' | 'launch';

const StableWorkspacePanel = memo(WorkspacePanel);
const StableWorkflowPanel = memo(WorkflowPanel);
const StableRunPanel = memo(RunPanel);
const StableRunWorkspace = memo(RunWorkspace);

export interface ShellLayout {
  launchpadWidth: number;
  inspectorWidth: number;
}

export function AppShell() {
  const { t } = useUiPreferences();
  const [layout, setLayout] = useState(loadShellLayout);
  const [launchpadView, setLaunchpadView] = useState<LaunchpadView>('launch');
  const [launchpadOpen, setLaunchpadOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const resizeCleanup = useRef<() => void>();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* Persistence is optional. */ }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [layout]);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  useEffect(() => () => resizeCleanup.current?.(), []);

  const fittedLayout = fitShellLayout(layout, viewportWidth, launchpadOpen, inspectorOpen);

  const showLaunchpad = (view: LaunchpadView) => {
    setLaunchpadView(view);
    setLaunchpadOpen(true);
  };
  const resize = (key: keyof ShellLayout, start: ReactPointerEvent<HTMLDivElement>) => {
    start.preventDefault();
    start.currentTarget.setPointerCapture(start.pointerId);
    const origin = start.clientX;
    const initial = fittedLayout[key];
    let nextValue = initial;
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      setLayout((current) => ({ ...current, [key]: clampShellWidth(key, nextValue) }));
    };
    const move = (event: PointerEvent) => {
      nextValue = initial + event.clientX - origin;
      if (frame === undefined) frame = requestAnimationFrame(flush);
    };
    const up = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      flush();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      resizeCleanup.current = undefined;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    resizeCleanup.current?.();
    resizeCleanup.current = up;
  };
  const resizeWithKeyboard = (key: keyof ShellLayout, delta: number) => setLayout((current) => ({ ...current, [key]: clampShellWidth(key, fittedLayout[key] + delta) }));

  const columns = `${RAIL_WIDTH}px ${launchpadOpen ? `${fittedLayout.launchpadWidth}px ${DIVIDER_WIDTH}px` : '0px 0px'} ${inspectorOpen ? `${fittedLayout.inspectorWidth}px ${DIVIDER_WIDTH}px` : '0px 0px'} minmax(${MIN_WORKSPACE_WIDTH}px, 1fr)`;
  return <div className="grid h-full min-h-0 min-w-0 overflow-hidden" style={{ gridTemplateColumns: columns }} data-testid="app-shell">
    <NavigationRail launchpadView={launchpadView} launchpadOpen={launchpadOpen} inspectorOpen={inspectorOpen} onView={showLaunchpad} onToggleLaunchpad={() => setLaunchpadOpen((value) => !value)} onToggleInspector={() => setInspectorOpen((value) => !value)} />
    <aside aria-label={t('shell.launchpad')} aria-hidden={!launchpadOpen} className="min-h-0 min-w-0 overflow-hidden border-r border-border bg-panel">
      <div hidden={!launchpadOpen} data-testid="launchpad-content" className="h-full min-h-0">
        <div id="launchpad-projects" hidden={launchpadView !== 'projects'} className="h-full min-h-0"><StableWorkspacePanel /></div>
        <div id="launchpad-launch" hidden={launchpadView !== 'launch'} className="h-full min-h-0"><StableWorkflowPanel /></div>
      </div>
    </aside>
    {launchpadOpen ? <Divider label={t('shell.resizeLaunchpad')} value={fittedLayout.launchpadWidth} min={MIN_LAYOUT.launchpadWidth} max={MAX_LAYOUT.launchpadWidth} onPointerDown={(event) => resize('launchpadWidth', event)} onDelta={(delta) => resizeWithKeyboard('launchpadWidth', delta)} /> : <div />}
    <aside aria-label={t('shell.activity')} aria-hidden={!inspectorOpen} className="min-h-0 min-w-0 overflow-hidden border-r border-border bg-panel"><div hidden={!inspectorOpen} data-testid="inspector-content" className="h-full"><StableRunPanel /></div></aside>
    {inspectorOpen ? <Divider label={t('shell.resizeActivity')} value={fittedLayout.inspectorWidth} min={MIN_LAYOUT.inspectorWidth} max={MAX_LAYOUT.inspectorWidth} onPointerDown={(event) => resize('inspectorWidth', event)} onDelta={(delta) => resizeWithKeyboard('inspectorWidth', delta)} /> : <div />}
    <div className="min-h-0 min-w-0 overflow-hidden"><StableRunWorkspace /></div>
  </div>;
}

function NavigationRail({ launchpadView, launchpadOpen, inspectorOpen, onView, onToggleLaunchpad, onToggleInspector }: {
  launchpadView: LaunchpadView;
  launchpadOpen: boolean;
  inspectorOpen: boolean;
  onView(view: LaunchpadView): void;
  onToggleLaunchpad(): void;
  onToggleInspector(): void;
}) {
  const { t } = useUiPreferences();
  return <nav aria-label={t('shell.primary')} className="z-10 flex min-h-0 flex-col items-stretch gap-1 border-r border-border bg-canvas px-2 py-2">
    <span className="mb-2 grid h-8 place-items-center rounded-lg bg-gradient-to-r from-violet-600 via-amber-500 to-teal-500 text-xs font-black text-white" title="Multi-AI Terminal">MAT</span>
    <RailButton label={t('shell.projects')} selected={launchpadOpen && launchpadView === 'projects'} controls="launchpad-projects" onClick={() => onView('projects')} icon={<ProjectsIcon />} />
    <RailButton label={t('shell.launch')} selected={launchpadOpen && launchpadView === 'launch'} controls="launchpad-launch" onClick={() => onView('launch')} icon={<LaunchIcon />} />
    <div className="my-1 h-px bg-border" />
    <RailButton label={launchpadOpen ? t('shell.hideSettings') : t('shell.showSettings')} selected={launchpadOpen} onClick={onToggleLaunchpad} icon={<PanelIcon side="left" />} />
    <RailButton label={inspectorOpen ? t('shell.hideActivity') : t('shell.showActivity')} selected={inspectorOpen} onClick={onToggleInspector} icon={<PanelIcon side="right" />} />
  </nav>;
}

function RailButton({ label, selected, controls, icon, onClick }: { label: string; selected: boolean; controls?: string; icon: ReactNode; onClick(): void }) {
  return <button type="button" aria-label={label} aria-pressed={selected} {...(controls ? { 'aria-controls': controls } : {})} onClick={onClick} className={`flex min-h-11 w-full items-center gap-2 rounded-lg border px-2 text-left text-[10px] font-medium leading-tight transition-colors ${selected ? 'border-accentBorder bg-accentSoft/70 text-accentForeground' : 'border-transparent text-muted hover:border-border hover:bg-surface hover:text-ink'}`} title={label}><span className="shrink-0">{icon}</span><span>{label}</span></button>;
}

function Divider({ label, value, min, max, onPointerDown, onDelta }: { label: string; value: number; min: number; max: number; onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void; onDelta(delta: number): void }) {
  return <div role="separator" aria-label={label} tabIndex={0} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} pixels`} onPointerDown={onPointerDown} onKeyDown={(event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); onDelta(-10); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); onDelta(10); }
  }} className="cursor-col-resize bg-canvas outline-none transition-colors hover:bg-accent focus:bg-accent" />;
}

export function loadShellLayout(): ShellLayout {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<ShellLayout> | null;
    if (value && typeof value.launchpadWidth === 'number' && Number.isFinite(value.launchpadWidth) && typeof value.inspectorWidth === 'number' && Number.isFinite(value.inspectorWidth)) {
      return {
        launchpadWidth: clampShellWidth('launchpadWidth', value.launchpadWidth),
        inspectorWidth: clampShellWidth('inspectorWidth', value.inspectorWidth),
      };
    }
  } catch { /* Use defaults for malformed or unavailable storage. */ }
  return { ...DEFAULT_LAYOUT };
}

export function fitShellLayout(preferred: ShellLayout, viewportWidth: number, launchpadOpen: boolean, inspectorOpen: boolean): ShellLayout {
  let launchpadWidth = clampShellWidth('launchpadWidth', preferred.launchpadWidth);
  let inspectorWidth = clampShellWidth('inspectorWidth', preferred.inspectorWidth);
  const openCount = Number(launchpadOpen) + Number(inspectorOpen);
  const available = Math.max(0, viewportWidth - RAIL_WIDTH - openCount * DIVIDER_WIDTH - MIN_WORKSPACE_WIDTH);
  if (launchpadOpen && inspectorOpen && launchpadWidth + inspectorWidth > available) {
    let excess = launchpadWidth + inspectorWidth - available;
    const launchpadRoom = launchpadWidth - MIN_LAYOUT.launchpadWidth;
    const inspectorRoom = inspectorWidth - MIN_LAYOUT.inspectorWidth;
    const totalRoom = launchpadRoom + inspectorRoom;
    if (totalRoom > 0) {
      const launchpadReduction = Math.min(launchpadRoom, Math.ceil(excess * launchpadRoom / totalRoom));
      launchpadWidth -= launchpadReduction;
      excess -= launchpadReduction;
      inspectorWidth -= Math.min(inspectorRoom, excess);
    }
  } else if (launchpadOpen && !inspectorOpen) launchpadWidth = Math.min(launchpadWidth, Math.max(MIN_LAYOUT.launchpadWidth, available));
  else if (!launchpadOpen && inspectorOpen) inspectorWidth = Math.min(inspectorWidth, Math.max(MIN_LAYOUT.inspectorWidth, available));
  return { launchpadWidth, inspectorWidth };
}

function clampShellWidth(key: keyof ShellLayout, value: number): number {
  return Math.min(MAX_LAYOUT[key], Math.max(MIN_LAYOUT[key], value));
}

function ProjectsIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.6"><path d="M3 5.5h5l1.5 2H17v8.5H3z" strokeLinejoin="round" /><path d="M3 7.5h14" /></svg>;
}
function LaunchIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.6"><path d="M11.5 3.5c2-.4 3.7-.3 5 .1.4 1.3.5 3-.1 5l-4.2 4.2-5-5z" strokeLinejoin="round" /><path d="m7.7 12.3-3.2 3.2M6 10l-2 .7-.8 2.5M10 14l-.7 2 2.5.8" strokeLinecap="round" /></svg>;
}
function PanelIcon({ side }: { side: 'left' | 'right' }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.6"><rect x="3" y="4" width="14" height="12" rx="1.5" />{side === 'left' ? <path d="M7.5 4v12" /> : <path d="M12.5 4v12" />}</svg>;
}
