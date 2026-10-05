// Browser wallets via the Wallet Standard (Phantom, Solflare, Backpack, ...). The page only asks a wallet to SIGN a
// transaction the server built; the server relays it (sdk/wallet_tx.ts). Keys never leave the wallet.
import { useSyncExternalStore } from 'react';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { FIXTURE_MODE } from './api';

const CONNECT = 'standard:connect', DISCONNECT = 'standard:disconnect', SIGN_TX = 'solana:signTransaction', SIGN_MSG = 'solana:signMessage';
const LAST_KEY = 'trenches-last-wallet';
export const CHAIN = 'solana:devnet';

export interface WalletState {
  available: Wallet[];
  wallet: Wallet | null;
  account: WalletAccount | null;
  address: string | null;
  connecting: boolean;
  error: string | null;
}

const supports = (w: Wallet) => CONNECT in w.features && SIGN_TX in w.features && w.chains.some((c) => c.startsWith('solana:'));

let state: WalletState = { available: [], wallet: null, account: null, address: null, connecting: false, error: null };
const listeners = new Set<() => void>();
function set(p: Partial<WalletState>) { state = { ...state, ...p }; listeners.forEach((l) => l()); }
const sub = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const useWallet = () => useSyncExternalStore(sub, () => state);

let started = false;
/** Find installed wallets (they can register late) and quietly reconnect the last one used. */
export function startWallets() {
  if (started) return; started = true;
  if (FIXTURE_MODE) registerFixtureWallet();
  const api = getWallets();
  const refresh = () => set({ available: api.get().filter(supports) });
  refresh();
  api.on('register', refresh); api.on('unregister', refresh);
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* storage blocked */ }
  if (last) {
    const tryAuto = () => { const w = state.available.find((x) => x.name === last); if (w && !state.wallet) void connect(w, true); };
    tryAuto(); api.on('register', tryAuto);
  }
}

export async function connect(w: Wallet, silent = false) {
  set({ connecting: true, error: null });
  try {
    const out = await (w.features[CONNECT] as any).connect(silent ? { silent: true } : undefined);
    const account: WalletAccount | undefined = (out?.accounts ?? w.accounts)[0];
    if (!account) { set({ connecting: false }); return; }
    set({ wallet: w, account, address: account.address, connecting: false });
    try { localStorage.setItem(LAST_KEY, w.name); } catch { /* storage blocked */ }
    (w.features['standard:events'] as any)?.on?.('change', () => {
      const a = w.accounts[0];
      if (!a) set({ wallet: null, account: null, address: null }); else set({ account: a, address: a.address });
    });
  } catch (e) {
    set({ connecting: false, error: silent ? null : (e as Error).message || 'The wallet refused the connection' });
  }
}

export async function disconnect() {
  const w = state.wallet;
  set({ wallet: null, account: null, address: null, error: null });
  try { localStorage.removeItem(LAST_KEY); } catch { /* storage blocked */ }
  try { await (w?.features[DISCONNECT] as any)?.disconnect?.(); } catch { /* wallet already gone */ }
}

/** Ask the connected wallet to sign the serialized (unsigned) transaction; the result is the signed wire bytes. */
export async function signTransaction(tx: Uint8Array): Promise<Uint8Array> {
  const { wallet, account } = state;
  if (!wallet || !account) throw new Error('Connect a wallet first');
  const [out] = await (wallet.features[SIGN_TX] as any).signTransaction({ account, transaction: tx, chain: CHAIN });
  return out.signedTransaction as Uint8Array;
}

/** Ask the connected wallet to sign a plain message (studio sign-in). Not a transaction; costs nothing. */
export async function signMessage(message: Uint8Array): Promise<Uint8Array> {
  const { wallet, account } = state;
  if (!wallet || !account) throw new Error('Connect a wallet first');
  const f = wallet.features[SIGN_MSG] as any;
  if (!f?.signMessage) throw new Error(`${wallet.name} can't sign messages; use another wallet for the studio`);
  const [out] = await f.signMessage({ account, message });
  return out.signature as Uint8Array;
}

export const hexToBytes = (h: string) => { if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new Error('bad transaction encoding'); const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; };
export const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const bytesToB64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

// ---------- fixture mode: a pretend wallet so the whole flow can be clicked through without an extension
function registerFixtureWallet() {
  const address = 'FixtureBrowserWaLLet11111111111111111111111';
  const account = { address, publicKey: new Uint8Array(32), chains: [CHAIN], features: [SIGN_TX] } as unknown as WalletAccount;
  const w: Wallet = {
    version: '1.0.0', name: 'Fixture wallet (simulated)', chains: [CHAIN], accounts: [account],
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#c39bff"/></svg>') as any,
    features: {
      [CONNECT]: { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      [DISCONNECT]: { version: '1.0.0', disconnect: async () => {} },
      [SIGN_TX]: { version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: async ({ transaction }: any) => [{ signedTransaction: transaction }] },
      [SIGN_MSG]: { version: '1.0.0', signMessage: async ({ message }: any) => [{ signedMessage: message, signature: new Uint8Array(64).fill(7) }] },
    } as any,
  };
  (getWallets() as any).register(w);
}
