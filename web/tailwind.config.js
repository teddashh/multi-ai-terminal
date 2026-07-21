/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised: 'rgb(var(--raised) / <alpha-value>)',
        control: 'rgb(var(--control) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        accentSoft: 'rgb(var(--accent-soft) / <alpha-value>)',
        accentForeground: 'rgb(var(--accent-foreground) / <alpha-value>)',
        accentBorder: 'rgb(var(--accent-border) / <alpha-value>)',
        onAccent: 'rgb(var(--on-accent) / <alpha-value>)',
      },
    },
  },
  plugins: [],
};
