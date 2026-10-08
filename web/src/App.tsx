import { useEffect, useState, type ReactNode } from 'react';
import { api, FIXTURE_MODE } from './lib/api';
import { navigate, usePath, usePoll } from './lib/hooks';
import { setQuery, setTheme, useQuery, useTheme } from './lib/ui';
import { HOOKD_X_URL, hookdChartUrl } from './lib/links';
import { Guard, Link, Skeleton } from './components/bits';
import { IconBook, IconChart, IconEye, IconGrid, IconHome, IconHook, IconMenu, IconMoon, IconPlus, IconSearch, IconSun, IconX } from './components/Icons';
import { TokensPage } from './pages/TokensPage';
import { HomePage } from './pages/HomePage';
import { WalletButton } from './components/WalletButton';
import { TokenPage } from './pages/TokenPage';
import { HooksPage } from './pages/HooksPage';
import { CreatePage } from './pages/CreatePage';
import { TransparencyPage } from './pages/TransparencyPage';
import { DocsPage } from './pages/DocsPage';


function CapPageRedirect() {
  useEffect(() => navigate('/hooks#hook-cap', { replace: true }), []);
  return null;
}

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
  if (path === '/how-it-works' || path === '/how-it-works/') page = <CapPageRedirect />;
  else if (!m) page = meta.error
    ? <div className="card"><h2>Couldn't reach the launch page backend</h2><p className="muted small" style={{ marginTop: 8 }}>{meta.error.message}. Start it with <code>pnpm page -- --cluster devnet</code> (port 5175), or run <code>pnpm dev:fixtures</code> in web/ for simulated data.</p></div>
    : <div className="stack"><Skeleton h={150} /><Skeleton h={320} /></div>;
  else if (tokenMatch) page = <TokenPage key={tokenMatch[1]} mint={decodeURIComponent(tokenMatch[1])} meta={m} />;
  else if (path === '/hooks') page = <HooksPage meta={m} />;
  else if (path === '/create') page = <CreatePage meta={m} />;
  else if (path === '/docs') page = <DocsPage meta={m} />;
  else if (path === '/transparency') page = <TransparencyPage meta={m} />;
  else if (path === '/tokens') page = <TokensPage meta={m} />;
  else if (path === '/') page = <HomePage meta={m} />;
  else page = <div className="card"><h2>Page not found</h2><p style={{ marginTop: 8 }}><Link to="/" className="link">Back to home</Link></p></div>;

  const isActive = (to: string) => (to === '/tokens' ? path === '/tokens' || path.startsWith('/token/') : path === to);
  const nav = (to: string, label: string, icon: ReactNode) => <Link to={to} className={isActive(to) ? 'active' : ''}>{icon}{label}</Link>;

  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? 'open' : ''}`} aria-label="Sidebar">
        <Link to="/" className="logo" aria-label="Hookd home">
          <span className={`brand-lockup brand-lockup--${theme}`}>
            <img src={`/brand/hookd-${theme === 'dark' ? 'white' : 'black'}.png`} alt="Hookd" width={theme === 'dark' ? 2172 : 1774} height={theme === 'dark' ? 724 : 887} />
          </span>
        </Link>
        <nav className="side-nav" aria-label="Main">
          {nav('/', 'Home', <IconHome />)}
          {nav('/tokens', 'Tokens', <IconGrid />)}
          {nav('/create', m?.launch?.mode === 'open' ? 'Launch' : 'Studio launch', <IconPlus />)}
          {nav('/hooks', 'Hooks', <IconHook />)}
          {nav('/transparency', 'Transparency', <IconEye />)}
        </nav>
        <div className="side-foot">
          <nav className="side-nav" aria-label="Resources">
            {nav('/docs', 'Docs', <IconBook />)}
          </nav>
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
            <input placeholder="Search name, ticker or mint" value={q} onChange={(e) => { setQuery(e.target.value); if (path !== '/tokens') navigate('/tokens'); }} />
          </label>
          <div className="actions">
            <TopLink href={HOOKD_X_URL} label="Hookd on X"><IconX size={15} /></TopLink>
            <TopLink href={hookdChartUrl} label="Chart on GMGN"><IconChart size={18} /></TopLink>
            <button className="primary hide-sm" onClick={() => navigate('/create')}>Launch</button>
            <WalletButton />
          </div>
        </header>
        {FIXTURE_MODE
          ? <p className="sample-banner" role="note"><b>Preview</b> Sample data: these tokens, trades and wallets are not real.</p>
          : <p className="sample-banner" role="note" id="top-banner"><b>UNAUDITED EXPERIMENT — DEVNET</b> <span id="badge">DEVNET TEST - no real value</span></p>}
        <main><Guard what="this page">{page}</Guard></main>
      </div>
    </div>
  );
}

/** A top-bar icon link that opens in a new tab; disabled ("coming soon") while its address is not set yet. */
function TopLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return href
    ? <a className="icon-btn" href={href} target="_blank" rel="noreferrer" aria-label={label} title={label}>{children}</a>
    : <button type="button" className="icon-btn" disabled aria-label={`${label}: coming soon`} title={`${label}: coming soon`}>{children}</button>;
}
