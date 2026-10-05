import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startWallets } from './lib/wallet';
import './styles.css';
import './hooks.css';
import './home.css';

startWallets();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
