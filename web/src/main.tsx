import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App.js';
import './app/theme.css';
import { apiClient } from './api/client.js';

function reportClientError(value: unknown): void {
  try {
    const error = value instanceof Error ? value : new Error(typeof value === 'string' ? value : String(value));
    void apiClient.clientLog({ level: 'error', message: error.message.slice(0, 4000), ...(error.stack ? { stack: error.stack.slice(0, 8000) } : {}), url: window.location.href }).catch(() => undefined);
  } catch { /* Client diagnostics never interfere with the error surface. */ }
}

window.addEventListener('error', (event) => reportClientError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => reportClientError(event.reason));

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
ReactDOM.createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
