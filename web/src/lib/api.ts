// Data source: the real backend (app/server.ts via the Vite proxy), or the simulated one in fixture mode.
import type { Meta, TokenView, TradeResult, Side, CreateRequest, CreateReply, BuiltSwap } from './types';
import { fixtureApi } from './fixtures';
import { ApiError } from './errors';
export { ApiError };

export const FIXTURE_MODE = import.meta.env.MODE === 'fixtures';

export interface Api {
  meta(): Promise<Meta>;
  token(mint: string, owner?: string | null): Promise<TokenView>;
  /** server-signed demo trade with throwaway test wallet A/B */
  trade(mint: string, wallet: string, side: Side, amount: string): Promise<TradeResult>;
  /** AC-21: unsigned swap for the user's wallet (simulated); the wallet signs, then walletSubmit relays it */
  walletBuild(mint: string, owner: string, side: Side, amount: string): Promise<BuiltSwap>;
  walletSubmit(signedTxBase64: string): Promise<TradeResult>;
  create(req: CreateRequest): Promise<CreateReply>;
}


async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  let body: any = null;
  try { body = await r.json(); } catch { /* non-JSON error page */ }
  if (!r.ok) throw new ApiError(body?.error ?? r.statusText, r.status);
  return body as T;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const httpApi: Api = {
  meta: () => call<Meta>('/api/meta'),
  token: (mint, owner) => call<TokenView>(`/api/token/${encodeURIComponent(mint)}${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`),
  trade: (mint, wallet, side, amount) => call<TradeResult>('/api/trade', post({ mint, wallet, side, amount })),
  walletBuild: (mint, owner, side, amount) => call<BuiltSwap>('/api/wallet/build', post({ mint, owner, side, amount })),
  walletSubmit: (tx) => call<TradeResult>('/api/wallet/submit', post({ tx })),
  create: (req) => call<CreateReply>('/api/create', post(req)),
};

export const api: Api = FIXTURE_MODE ? fixtureApi : httpApi;
