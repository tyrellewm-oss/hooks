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

// The preloader (index.html) leaves once its animation has played and the page has loaded.
const preloader = document.getElementById('preloader');
if (preloader) {
  const played = new Promise((done) => setTimeout(done, matchMedia('(prefers-reduced-motion: reduce)').matches ? 300 : 2900));
  const loaded = new Promise((done) => (document.readyState === 'complete' ? done(null) : addEventListener('load', () => done(null), { once: true })));
  void Promise.all([played, loaded]).then(() => {
    preloader.classList.add('done');
    setTimeout(() => preloader.remove(), 450);
  });
}
