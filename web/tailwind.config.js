/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { panel: 'var(--panel)', border: 'var(--border)', ink: 'var(--ink)', muted: 'var(--muted)', accent: 'var(--accent)' } } },
  plugins: [],
};
