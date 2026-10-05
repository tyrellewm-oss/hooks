import { useEffect, useState, type ReactNode } from 'react';
import { api } from './lib/api';
import { navigate, usePath, usePoll } from './lib/hooks';
import { setQuery, setTheme, useQuery, useTheme } from './lib/ui';
import { CONTENT, fill, pageVars } from './lib/shared';
import { Guard, Link, Skeleton } from './components/bits';
import { IconEye, IconGrid, IconMenu, IconMoon, IconPlus, IconRamp, IconSearch, IconSun, LogoMark } from './components/Icons';
import { TokensPage } from './pages/TokensPage';
import { WalletButton } from './components/WalletButton';
import { TokenPage } from './pages/TokenPage';
import { HowItWorksPage } from './pages/HowItWorksPage';
import { CreatePage } from './pages/CreatePage';
import { TransparencyPage } from './pages/TransparencyPage';


export function App() {
  const path = usePath();
  const meta = usePoll(() => api.meta(), 30000, 'meta');
  const m = meta.data;
  const theme = useTheme();
  const q = useQuery();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);

  let page: ReactNode;
  const tokenMatch = path.match(/^\/token\/([^/]+)\/?$/);
  if (!m) page = meta.error
    ? <div className="card"><h2>Couldn't reach the launch page backend</h2><p className="muted small" style={{ marginTop: 8 }}>{meta.error.message}. Start it with <code>pnpm page -- --cluster devnet</code> (port 5175), or run <code>pnpm dev:fixtures</code> in web/ for simulated data.</p></div>
    : <div className="stack"><Skeleton h={150} /><Skeleton h={320} /></div>;
  else if (tokenMatch) page = <TokenPage key={tokenMatch[1]} mint={decodeURIComponent(tokenMatch[1])} meta={m} />;
  else if (path === '/how-it-works') page = <HowItWorksPage meta={m} />;
  else if (path === '/create') page = <CreatePage meta={m} />;
  else if (path === '/transparency') page = <TransparencyPage meta={m} />;
  else if (path === '/') page = <TokensPage meta={m} />;
  else page = <div className="card"><h2>Page not found</h2><p style={{ marginTop: 8 }}><Link to="/" className="link">Back to tokens</Link></p></div>;

  const isActive = (to: string) => (to === '/' ? path === '/' || path.startsWith('/token/') : path === to);
  const nav = (to: string, label: string, icon: ReactNode) => <Link to={to} className={isActive(to) ? 'active' : ''}>{icon}{label}</Link>;

  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? 'open' : ''}`} aria-label="Sidebar">
        <Link to="/" className="logo"><span className="logo-mark"><LogoMark /></span>Trenches</Link>
        <nav className="side-nav" aria-label="Main">
          {nav('/', 'Tokens', <IconGrid />)}
          {nav('/how-it-works', 'How the cap works', <IconRamp />)}
          {nav('/transparency', 'Transparency', <IconEye />)}
          {nav('/create', 'Studio launch', <IconPlus />)}
        </nav>
        <div className="side-foot">
          <div className="side-card" title={m ? `program ${m.programId}` : undefined}>
            <div className="row" style={{ color: 'var(--text-2)', fontWeight: 500 }}>
              <span className={`dot ${meta.error ? 'down' : !m ? 'stale' : ''}`} />{m ? m.cluster : 'connecting…'}
            </div>
            <div className="mono" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m?.rpc ?? '…'}</div>
          </div>
          <div className="theme-toggle" role="group" aria-label="Theme">
            <button className={theme === 'dark' ? 'on' : ''} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><IconMoon size={14} />Dark</button>
            <button className={theme === 'light' ? 'on' : ''} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><IconSun size={14} />Light</button>
          </div>
        </div>
      </aside>
      {menu && <div className="side-scrim" onClick={() => setMenu(false)} />}

      <div className="main-col">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setMenu(true)}><IconMenu size={18} /></button>
          <label className="search">
            <IconSearch size={15} />
            <span className="sr-only">Search tokens</span>
            <input placeholder="Search name, ticker or mint" value={q} onChange={(e) => { setQuery(e.target.value); if (path !== '/') navigate('/'); }} />
          </label>
          <div className="actions">
            <span className="badge">{CONTENT.devnet_label}</span>
            <button className="primary hide-sm" onClick={() => navigate('/create')}>Launch</button>
            <WalletButton />
          </div>
        </header>
        {/* AC-23: the banner string from page copy shows on every page (slim, under the top bar) */}
        <div className="banner">{CONTENT.banner}</div>
        <main><Guard what="this page">{page}</Guard></main>
        <footer>{m ? <Guard what="the footer">{fill(CONTENT.footer, pageVars(m, null))}</Guard> : CONTENT.banner}</footer>
      </div>
    </div>
  );
}
