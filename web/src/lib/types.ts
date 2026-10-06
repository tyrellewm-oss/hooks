// Shapes of the existing backend's JSON (app/server.ts). bigint values arrive as decimal strings.

export interface StepJson { slotOffset: string; maxBps: number }

export interface ScheduleJson { id: string; name: string; label: string; steps: StepJson[]; uncappedAfter: string }

export interface Meta {
  defaultSchedule: ScheduleJson;
  cluster: 'LOCAL' | 'DEVNET';
  rpc: string;
  programId: string;
  commit: string;
  liftAuthority: string;
  wallets: Record<string, string>;
  launches: { mint: string; pool: string; time: string }[];
  /** studio sign-in (sdk/studio_auth.ts): required = sign in to create or edit details; configured = an allowlist exists */
  studio?: { required: boolean; configured: boolean };
  /** the server also sends page_content.json; the UI imports it directly instead */
  content?: unknown;
}

/** lp.status() in sdk/launch.ts */
export interface TokenStatus {
  cluster: string;
  slot: number;
  mint: string;
  supply: string;
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  transferHookProgram: string | null;
  transferHookAuthority: string | null;
  launchSlot?: string;
  steps?: StepJson[];
  uncappedAfter?: string;
  testSlotsBuild?: boolean;
  exemptOwners?: string[];
  launcher?: string;
  liftAuthority?: string;
  launchAuthority?: string | null;
  globalLifted?: boolean;
  mintLifted?: boolean;
  raisedFloorBps?: number;
  currentCap?: string | null;
  nextChange?: { slot: string; bps: number | null } | null;
  mintHook?: { ok: boolean; phase: string | null; problems: string[] };
}

/** feeInfo() in app/server.ts: read from the on-chain DBC config */
export interface FeeInfo {
  mode: string;
  cliffPct: number;
  endPct: number;
  periods: number;
  periodSlots: number;
  totalSlots: number;
  collectFeeMode: number;
  migrationFeeOption: number;
  creatorTradingFeePercentage: number;
  migrationQuoteThresholdSol: number;
}

export interface LaunchRecord {
  name?: string;
  symbol?: string;
  mint: string;
  pool: string;
  config: string;
  time: string;
  steps: StepJson[];
  uncappedAfter: string;
  migrationQuoteThresholdSol: number;
  fee?: Record<string, unknown>;
  txs?: Record<string, string>;
}

export interface SwitchEvent {
  scope: string;
  oldMinCapBps: number;
  newMinCapBps: number;
  lifted: boolean;
  slot: string;
  signer: string;
  link: string;
}

/** Studio-entered token details (sdk/metadata.ts publicMetadata): image is a URL, never bytes */
export interface TokenMetadata { description: string; website: string | null; x: string | null; telegram: string | null; image: string | null; updatedAt: string }
export interface MetadataInput { description: string; website: string; x: string; telegram: string; image?: { data: string } | null }

/** The optional hooks a launch can turn on (sdk/buy_rules.ts). Shares are bps of supply; 0 = off. */
export interface BuyRulesInput { maxBuyBps: number; maxPerSlotBps: number; windowSlots: string; potEvery: number; potMinBps: number }
export interface PotWinner { owner: string; tokenAccount: string; buyIndex: string; slot: string }
/** rulesView() in app/server.ts: the token's rules account, live */
export interface RulesView extends BuyRulesInput { launchSlot: string; buyCount: string; wins: string; winners: PotWinner[] }

export interface TokenView {
  status: TokenStatus;
  launch: LaunchRecord | null;
  /** optional hooks; null = launched without them */
  rules?: RulesView | null;
  metadata?: TokenMetadata | null;
  fee: FeeInfo | null;
  feeConfig: Record<string, unknown> | null;
  pool: { quoteReserveSol: number; isMigrated: boolean; curveComplete: boolean } | null;
  balances: Record<string, string>;
  /** the connected browser wallet, when requested with ?owner= */
  wallet?: { owner: string; tokens: string; sol: number } | null;
  switchHistory: SwitchEvent[];
  explorer: { mint: string; pool: string | null; program: string };
}

/** TxRecord from sendTx() in sdk/launch.ts */
export interface TradeResult {
  ok: boolean;
  sig: string;
  link: string;
  err?: string;
  hookError?: string | null;
  hookCode?: number | null;
  capHit?: { tokenAccount: string | null; owner: string; balance: string; cap: string; slot: string };
}

export type Side = 'buy' | 'sell';

/** /api/wallet/build (sdk/wallet_tx.ts): an unsigned swap for the user's wallet, already simulated */
export interface BuiltSwap {
  /** unsigned transaction, hex (base64 would be mangled by the server's redaction) */
  tx: string;
  encoding: 'hex';
  owner: string;
  side: Side;
  amount: string;
  lastValidBlockHeight: number;
  expiresInMs: number;
  simulation: { ok: boolean; err: string | null; hookError: string | null; hookCode: number | null; capHit: TradeResult['capHit'] | null; unitsConsumed: number | null };
  /** 'curve' before graduation (cap applies), 'pool' after (DAMM v2, quoted with a slippage limit) */
  venue: 'curve' | 'pool';
  /** pool only, lamports: buy = expected / most SOL in; sell = expected / least SOL out */
  quote?: { expectedLamports: string; limitLamports: string; slippageBps: number; priceImpactPct: string };
}

/** GET /api/flywheel (app/flywheel_public.ts): the keeper's public logs, registry mints only */
export interface PublicRun { runId: string; startedAt: string; status: string; reason: string; claimedLamports: string; links: { what: string; sig: string; link: string }[] }
export interface PublicKeeper {
  name: string; mint: string; state: string; paused: boolean; pauseReason: string;
  claimedSol: string; devSol: string; spentSol: string; reserveSol: string;
  burnedTokens: string; supplyTokens: string; pctOfSupply: string;
  burns: { at: string; tokens: string; sol: string; sig: string; link: string }[];
  runs: PublicRun[];
  pools: { dbc: string | null; route: string | null };
}
export interface FlywheelReply { cluster: string; keepers: PublicKeeper[]; skipped: string[] }

/** GET /api/token/:mint/trades (sdk/indexer.ts via app/server.ts) */
export interface IndexedTrade { sig: string; slot: number; time: number | null; pool: string; venue: 'curve' | 'pool'; side: 'buy' | 'sell' | 'blocked'; trader: string; baseRaw: string; quoteLamports: string; price: number | null; error?: string }
export interface Candle { t: number; o: number; h: number; l: number; c: number; n: number }
export interface TradesReply { indexed: boolean; updatedAt: string | null; decimals: number | null; interval: number; trades: IndexedTrade[]; candles: Candle[] }

export interface CreateRequest {
  name: string;
  symbol: string;
  steps: StepJson[];
  uncappedAfter: string;
  thresholdSol: number;
  percentageSupplyOnMigration?: number;
  metadata?: MetadataInput;
  /** optional hooks; omitted = none */
  rules?: BuyRulesInput;
  /** AC-21 studio launch only: the connected wallet that pays and signs (needed where the studio is open without sign-in) */
  owner?: string;
}
export interface CreateReply { mint: string; pool: string; registered: false; note: string }
/** AC-21 studio launch: the server-built, co-signed launch tx the connected wallet signs (hex), plus what it creates */
export interface BuiltLaunch { tx: string; mint: string; config: string; pool: string; createConfigSig: string; simulation: string; expiresInMs: number }
export interface LaunchSubmitReply extends CreateReply { sig: string; link: string }
