import { useEffect, useRef, useState } from 'react';
import { connect, disconnect, useWallet } from '../lib/wallet';
import { short } from './bits';

const INSTALL = [
  { name: 'Phantom', url: 'https://phantom.com/download' },
  { name: 'Solflare', url: 'https://solflare.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/downloads' },
];

export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => { if (w.address) setOpen(false); }, [w.address]);

  return (
    <div className="wallet" ref={ref}>
      {w.address ? (
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" className="wallet-btn">
          {w.wallet?.icon && <img src={w.wallet.icon} alt="" width={16} height={16} />}
          <span className="mono">{short(w.address, 4)}</span>
        </button>
      ) : (
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" className="wallet-btn" disabled={w.connecting}>
          {w.connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
      )}
      {open && (
        <div className="wallet-pop" role="menu">
          {w.address ? (
            <>
              <div className="small faint" style={{ padding: '4px 8px 8px' }}>Connected with {w.wallet?.name}</div>
              <button role="menuitem" className="pop-item" onClick={async () => { try { await navigator.clipboard.writeText(w.address!); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* blocked */ } }}>{copied ? 'Copied' : 'Copy address'}</button>
              <button role="menuitem" className="pop-item" onClick={() => { void disconnect(); setOpen(false); }}>Disconnect</button>
            </>
          ) : w.available.length ? (
            <>
              <div className="small faint" style={{ padding: '4px 8px 8px' }}>Choose a wallet. Set it to devnet.</div>
              {w.available.map((x) => (
                <button key={x.name} role="menuitem" className="pop-item" onClick={() => void connect(x)}>
                  <img src={x.icon} alt="" width={20} height={20} style={{ borderRadius: 5 }} />{x.name}
                </button>
              ))}
            </>
          ) : (
            <div style={{ padding: '4px 8px' }}>
              <p className="small" style={{ margin: '0 0 8px' }}>No Solana wallet found in this browser. Install one, then reload:</p>
              {INSTALL.map((x) => <a key={x.name} className="pop-item" href={x.url} target="_blank" rel="noreferrer">{x.name} ↗</a>)}
            </div>
          )}
          {w.error && <p className="small fail" style={{ margin: '8px 8px 2px' }}>{w.error}</p>}
        </div>
      )}
    </div>
  );
}
