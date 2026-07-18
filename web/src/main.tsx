import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App.js';
import './app/theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
ReactDOM.createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
