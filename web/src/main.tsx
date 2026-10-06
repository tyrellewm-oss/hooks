import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startWallets } from './lib/wallet';
import './styles.css';
import './hooks.css';
import './home.css';
import './launch.css';
import './docs.css';
import './motion.css';
import './extra-hooks.css';
import './brand.css';
import { installBrandFx } from './lib/brandFx';

startWallets();
installBrandFx();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
