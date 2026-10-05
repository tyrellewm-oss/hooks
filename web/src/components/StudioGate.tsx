// Studio sign-in step for the studio tools (launch form, token details). Shows the children once signed in, or
// straight away when the server says no sign-in is needed (local cluster without a studio list).
import { useState, type ReactNode } from 'react';
import type { Meta } from '../lib/types';
import { useWallet } from '../lib/wallet';
import { studioSignIn, studioSignOut, useStudioAccess } from '../lib/studio';
import { short } from './bits';

export function StudioGate({ meta, children }: { meta: Meta; children: ReactNode }) {
  const required = meta.studio?.required ?? false;
  const configured = meta.studio?.configured ?? false;
  const { ok, session } = useStudioAccess(required);
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (ok) {
    return (
      <>
        {required && session && (
          <div className="row small faint" style={{ justifyContent: 'flex-end', marginBottom: 10, gap: 8 }}>
            <span className="pill green">Studio: {short(session.wallet, 4)}</span>
            <button className="ghost small" onClick={() => void studioSignOut()}>Sign out</button>
          </div>
        )}
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
    <div className="card" style={{ maxWidth: 560 }}>
      <h2 style={{ marginBottom: 8 }}>Studio sign-in</h2>
      <p className="muted small">Launching tokens and editing token details are for studio wallets only. Your wallet signs a short message to prove it's yours. It isn't a transaction and costs nothing.</p>
      {mismatch && <div className="notice amber small" style={{ marginBottom: 10 }}>You're signed in as {short(session!.wallet, 4)}, but the connected wallet is {short(w.address!, 4)}. Sign in again with this wallet.</div>}
      {!w.address
        ? <div className="notice small">Connect a wallet first (top right).</div>
        : <button className="primary" disabled={busy} onClick={go}>{busy ? 'Check your wallet…' : `Sign in with ${short(w.address, 4)}`}</button>}
      {err && <div className="notice red small" role="alert" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  );
}
