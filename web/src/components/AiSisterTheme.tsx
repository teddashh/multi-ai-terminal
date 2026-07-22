import type { CSSProperties } from 'react';
import chatgptAvatarUrl from '../assets/themes/ai-sister/chatgpt.webp';
import claudeAvatarUrl from '../assets/themes/ai-sister/claude.webp';
import ensembleUrl from '../assets/themes/ai-sister/ensemble.jpg';
import geminiAvatarUrl from '../assets/themes/ai-sister/gemini.webp';
import grokAvatarUrl from '../assets/themes/ai-sister/grok.webp';

const AVATARS = { claude: claudeAvatarUrl, codex: chatgptAvatarUrl, agy: geminiAvatarUrl, grok: grokAvatarUrl } as const;
const ACCENTS = {
  claude: ['#f6b94b', 'rgba(246, 185, 75, 0.48)'], codex: ['#2dd4bf', 'rgba(45, 212, 191, 0.48)'],
  agy: ['#a78bfa', 'rgba(167, 139, 250, 0.5)'], grok: ['#8b5cf6', 'rgba(139, 92, 246, 0.5)'],
} as const;

export function AiSisterAvatar({ provider }: { provider: string }) {
  if (!(provider in AVATARS)) return null;
  const mapped = provider as keyof typeof AVATARS;
  const style = { '--ai-sister-accent': ACCENTS[mapped][0], '--ai-sister-shadow': ACCENTS[mapped][1] } as CSSProperties;
  return <span className="ai-sister-only ai-sister-avatar" style={style} aria-hidden="true"><img src={AVATARS[mapped]} alt="" draggable={false} /></span>;
}

export function AiSisterEditionCard({ badge, title, subtitle }: { badge: string; title: string; subtitle: string }) {
  return <section className="ai-sister-only ai-sister-edition-card" aria-label={title}>
    <img src={ensembleUrl} alt="" draggable={false} className="ai-sister-ensemble" aria-hidden="true" />
    <div className="min-w-0"><div className="ai-sister-badge">{badge}</div><div className="truncate text-xs font-semibold text-ink">{title}</div><p className="mt-0.5 text-[10px] leading-snug text-muted">{subtitle}</p></div>
  </section>;
}
