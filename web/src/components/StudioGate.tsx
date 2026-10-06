// Studio sign-in step for the studio tools (launch form, token details). Shows the children once signed in, or
// straight away when the server says no sign-in is needed (local cluster without a studio list).
import { useState, type ReactNode } from 'react';
import type { Meta } from '../lib/types';
import { useWallet } from '../lib/wallet';
import { studioSignIn, studioSignOut, useStudioAccess } from '../lib/studio';
import { short } from './bits';
import { IconLock } from './Icons';
import { WalletButton } from './WalletButton';

export function StudioSessionControls({ wallet }: { wallet: string }) {
  return (
    <div className="studio-session row small faint">
      <span className="pill green">Studio: {short(wallet, 4)}</span>
      <button className="ghost small" onClick={() => void studioSignOut()}>Sign out</button>
    </div>
  );
}

export function StudioGate({ meta, children, variant = 'default', showSession = true }: { meta: Meta; children: ReactNode; variant?: 'default' | 'launch'; showSession?: boolean }) {
  const required = meta.studio?.required ?? false;
  const configured = meta.studio?.configured ?? false;
  const { ok, session } = useStudioAccess(required);
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (ok) {
    return (
      <>
        {showSession && required && session && <StudioSessionControls wallet={session.wallet} />}
        {children}
      </>
    );
  }
  if (!configured) {
    return <div className="notice amber"><b>The studio is closed on {meta.cluster.toLowerCase()}.</b> No studio wallets are configured on the server (STUDIO_WALLETS), so launches and token-detail edits are turned off.</div>;
  }
  const mismatch = session && w.address && session.wallet !== w.address;
  async function go() {
    if (!w.address) return;
    setBusy(true); setErr(null);
    try { await studioSignIn(w.address); }
    catch (e) { const m = (e as Error).message; setErr(/reject|denied|cancel/i.test(m) ? 'You declined in the wallet.' : m); }
    finally { setBusy(false); }
  }
  return (
    <div className={`card${variant === 'launch' ? ' studio-gate-entry' : ''}`} style={variant === 'default' ? { maxWidth: 560 } : undefined}>
      {variant === 'launch' && <div className="studio-gate-icon"><IconLock size={22} /></div>}
      <h2 style={{ marginBottom: 8 }}>Studio sign-in</h2>
      <p className="muted small">{variant === 'launch' ? 'Use your studio wallet to access the launch tool.' : "Launching tokens and editing token details are for studio wallets only. Your wallet signs a short message to prove it's yours. It isn't a transaction and costs nothing."}</p>
      {mismatch && <div className="notice amber small" style={{ marginBottom: 10 }}>You're signed in as {short(session!.wallet, 4)}, but the connected wallet is {short(w.address!, 4)}. Sign in again with this wallet.</div>}
      <div className={variant === 'launch' ? 'studio-gate-action' : undefined}>
      {!w.address
        ? variant === 'launch' ? <WalletButton primary /> : <div className="notice small">Connect a wallet first (top right).</div>
        : <button className="primary" disabled={busy} onClick={go}>{busy ? 'Check your wallet…' : `Sign in with ${short(w.address, 4)}`}</button>}
      </div>
      {err && <div className="notice red small" role="alert" style={{ marginTop: 10 }}>{err}</div>}
      {variant === 'launch' && <p className="studio-gate-note small muted">Sign a message to verify your wallet.<br />No transaction or fee.</p>}
    </div>
  );
}
