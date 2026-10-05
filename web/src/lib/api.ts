// Data source: the real backend (app/server.ts via the Vite proxy), or the simulated one in fixture mode.
import type { Meta, TokenView, TradeResult, Side, CreateRequest, CreateReply } from './types';
import { fixtureApi } from './fixtures';
import { ApiError } from './errors';
export { ApiError };

export const FIXTURE_MODE = import.meta.env.MODE === 'fixtures';

export interface Api {
  meta(): Promise<Meta>;
  token(mint: string): Promise<TokenView>;
  trade(mint: string, wallet: string, side: Side, amount: string): Promise<TradeResult>;
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
  token: (mint) => call<TokenView>(`/api/token/${encodeURIComponent(mint)}`),
  trade: (mint, wallet, side, amount) => call<TradeResult>('/api/trade', post({ mint, wallet, side, amount })),
  create: (req) => call<CreateReply>('/api/create', post(req)),
};

export const api: Api = FIXTURE_MODE ? fixtureApi : httpApi;
