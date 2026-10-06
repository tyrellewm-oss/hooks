// Studio sign-in on the page: the wallet signs the server's challenge message (no transaction), the server hands back a
// session token, and studio requests carry it in the x-studio-session header. Kept in sessionStorage (this tab only).
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { signMessage, useWallet } from './wallet';

const KEY = 'hookd-studio';
const EVENT = 'hookd:studio';
interface Saved { token: string; wallet: string }
let saved: Saved | null = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } })();

export const studioToken = () => saved?.token ?? null;
function set(v: Saved | null) {
  saved = v;
  try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch { /* storage blocked: session lasts this page view */ }
  window.dispatchEvent(new Event(EVENT));
}
/** Called by the API client when the server says the session is gone (401/403 on a studio route). */
export const clearStudioSession = () => { if (saved) set(null); };
const sub = (cb: () => void) => { window.addEventListener(EVENT, cb); return () => window.removeEventListener(EVENT, cb); };
export const useStudioSession = () => useSyncExternalStore(sub, () => saved);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export async function studioSignIn(wallet: string) {
  const ch = await api.studioChallenge(wallet);
  const sig = await signMessage(new TextEncoder().encode(ch.message));
  const s = await api.studioSession(wallet, ch.nonce, hex(sig));
  set({ token: s.token, wallet: s.wallet });
}
export async function studioSignOut() {
  try { await api.studioSignOut(); } catch { /* already gone */ }
  set(null);
}

/** Is studio access settled for this page: open, or signed in with the connected wallet. */
export function useStudioAccess(required: boolean) {
  const session = useStudioSession();
  const { address } = useWallet();
  return { required, session, ok: !required || (!!session && (!address || session.wallet === address)) };
}
