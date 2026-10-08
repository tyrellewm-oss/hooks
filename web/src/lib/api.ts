// Data source: the real backend (app/server.ts via the Vite proxy), or the simulated one in fixture mode.
import type { Meta, TokenView, TradeResult, Side, CreateRequest, CreateReply, BuiltSwap, FlywheelReply, TradesReply, MetadataInput, TokenMetadata , BuiltLaunch, LaunchSubmitReply, OpenConfigStep, OpenPoolStep, OpenLaunchReply } from './types';
import { fixtureApi } from './fixtures';
import { ApiError } from './errors';
import { studioToken, clearStudioSession } from './studio';
export { ApiError };

export const FIXTURE_MODE = import.meta.env.MODE === 'fixtures';

export interface Api {
  meta(): Promise<Meta>;
  token(mint: string, owner?: string | null): Promise<TokenView>;
  /** the quick read for lists: no switch-history scan, no test-wallet balances (partial: true) */
  cardView(mint: string): Promise<TokenView>;
  /** server-signed demo trade with throwaway test wallet A/B */
  trade(mint: string, wallet: string, side: Side, amount: string): Promise<TradeResult>;
  /** AC-21: unsigned swap for the user's wallet (simulated); the wallet signs, then walletSubmit relays it */
  walletBuild(mint: string, owner: string, side: Side, amount: string, opts?: { venue?: 'curve' | 'pool'; slippageBps?: number }): Promise<BuiltSwap>;
  walletSubmit(signedTxBase64: string): Promise<TradeResult>;
  create(req: CreateRequest): Promise<CreateReply>;
  /** AC-21 studio launch: the server builds and co-signs, the connected wallet signs, launchSubmit relays */
  launchBuild(req: CreateRequest): Promise<BuiltLaunch>;
  launchSubmit(txHex: string): Promise<LaunchSubmitReply>;
  /** open launch (any wallet; sdk/launch_open.ts): config -> build -> submit. The connected wallet signs the config tx,
   *  then the launch tx; the server co-signs and relays. Token details go with the submit. */
  openConfig(req: CreateRequest): Promise<OpenConfigStep>;
  openBuild(req: CreateRequest & { configTx: string; ticket: string }): Promise<OpenPoolStep>;
  openSubmit(poolTx: string, metadata?: MetadataInput): Promise<OpenLaunchReply>;
  flywheel(): Promise<FlywheelReply>;
  studioChallenge(wallet: string): Promise<{ nonce: string; message: string; expiresInMs: number }>;
  studioSession(wallet: string, nonce: string, signature: string): Promise<{ token: string; wallet: string; expiresInMs: number }>;
  studioSignOut(): Promise<{ ok: boolean }>;
  trades(mint: string, interval: number): Promise<TradesReply>;
  /** studio: set a token's image, description and links */
  saveMetadata(mint: string, m: MetadataInput): Promise<TokenMetadata>;
}


/** Studio routes: the session header goes with them; a 401/403 there means the session is gone. */
const STUDIO = /^\/api\/(create|studio|token\/[^/]+\/metadata)/;
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const studio = STUDIO.test(path), token = studioToken();
  if (studio && token) init = { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'x-studio-session': token } };
  const r = await fetch(path, init);
  if (studio && (r.status === 401 || r.status === 403) && !path.startsWith('/api/studio/challenge')) clearStudioSession();
  let body: any = null;
  try { body = await r.json(); } catch { /* non-JSON error page */ }
  if (!r.ok) throw new ApiError(body?.error ?? r.statusText, r.status);
  return body as T;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const httpApi: Api = {
  meta: () => call<Meta>('/api/meta'),
  token: (mint, owner) => call<TokenView>(`/api/token/${encodeURIComponent(mint)}${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`),
  cardView: (mint) => call<TokenView>(`/api/token/${encodeURIComponent(mint)}?view=card`),
  trade: (mint, wallet, side, amount) => call<TradeResult>('/api/trade', post({ mint, wallet, side, amount })),
  walletBuild: (mint, owner, side, amount, opts) => call<BuiltSwap>('/api/wallet/build', post({ mint, owner, side, amount, ...opts })),
  walletSubmit: (tx) => call<TradeResult>('/api/wallet/submit', post({ tx })),
  create: (req) => call<CreateReply>('/api/create', post(req)),
  launchBuild: (req) => call<BuiltLaunch>('/api/studio/launch/build', post(req)),
  launchSubmit: (txHex) => call<LaunchSubmitReply>('/api/studio/launch/submit', post({ tx: txHex })),
  openConfig: (req) => call<OpenConfigStep>('/api/launch/config', post(req)),
  openBuild: (req) => call<OpenPoolStep>('/api/launch/build', post(req)),
  openSubmit: (poolTx, metadata) => call<OpenLaunchReply>('/api/launch/submit', post({ poolTx, ...(metadata ? { metadata } : {}) })),
  flywheel: () => call<FlywheelReply>('/api/flywheel'),
  studioChallenge: (wallet) => call('/api/studio/challenge?wallet=' + encodeURIComponent(wallet)),
  studioSession: (wallet, nonce, signature) => call('/api/studio/session', post({ wallet, nonce, signature })),
  studioSignOut: () => call('/api/studio/signout', post({})),
  saveMetadata: (mint, m) => call<TokenMetadata>(`/api/token/${encodeURIComponent(mint)}/metadata`, post(m)),
  trades: (mint, interval) => call<TradesReply>(`/api/token/${encodeURIComponent(mint)}/trades?interval=${interval}`),
};

export const api: Api = FIXTURE_MODE ? fixtureApi : httpApi;
