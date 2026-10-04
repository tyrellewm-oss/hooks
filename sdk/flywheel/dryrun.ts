// Dry run, the DEFAULT for the keeper CLI's `run` and `loop` (`--send` is required to broadcast).
// A dry run executes the real keeper code path, unchanged, with two differences:
//   1. it works on a throwaway COPY of the saved state (state.json + PAUSE file) in a temp dir, with its own journal and
//      public log there; the real state dir, journal and public log are never opened for writing;
//   2. its connection never broadcasts: sendRawTransaction is replaced by simulateTransaction (read-only), and the step's
//      expected effect (from the intent the keeper journaled just before "sending") is applied to an in-memory overlay
//      of the treasury/dev token accounts and the mint supply, so later steps and the reconciliation see a consistent picture.
// A step whose simulation fails only because it needs an earlier dry-run step to have landed (e.g. the burn needs the
// swap's tokens) is reported as `dependent`, not as an error. Nothing from a dry run is persisted; the report is printed.
import { Connection, PublicKey, Transaction, VersionedTransaction, type AccountInfo } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { utils as anchorUtils } from '@coral-xyz/anchor';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { KeeperConfig } from './config.js';
import { MEMO_PROGRAM_ID } from './keeper.js';

const bs58 = anchorUtils.bytes.bs58;
export type SendMode = 'dry_run' | 'send';
/** Broadcasting needs the explicit `--send` flag; anything else is a dry run. */
export function parseSendMode(argv: string[]): SendMode { return argv.includes('--send') ? 'send' : 'dry_run'; }
export function banner(mode: SendMode, cfg: Pick<KeeperConfig, 'name' | 'cluster'>, cmd: string): string {
  const line = '='.repeat(78);
  return mode === 'send'
    ? `${line}\n  SENDING — ${cmd} on ${cfg.cluster} (${cfg.name}): transactions WILL be broadcast (--send given)\n${line}`
    : `${line}\n  DRY RUN — ${cmd} on ${cfg.cluster} (${cfg.name}): simulate only, nothing is broadcast, saved state is not changed.\n  Pass --send to broadcast.\n${line}`;
}

export interface DryStep { stage: string; sig: string; simulated: 'ok' | 'error' | 'dependent'; units?: number; err?: unknown; logs_tail?: string[]; effect: Record<string, string> }
export interface DryAccounts { feePayer?: PublicKey; tWsol: PublicKey; tMain: PublicKey; dWsol: PublicKey; mint: PublicKey; mainProg: PublicKey; mainMint: string }

const fileHash = (p: string) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'absent');

/** Copy of the saved state for one dry run. `cfg` points at the copy; `realUnchanged()` re-hashes the real files. */
export function isolateState(cfg: KeeperConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-dryrun-'));
  const stateDir = join(dir, 'state'); mkdirSync(stateDir, { recursive: true });
  for (const f of ['state.json', 'PAUSE', 'price_samples.jsonl']) if (existsSync(join(cfg.state_dir, f))) copyFileSync(join(cfg.state_dir, f), join(stateDir, f));
  const watched = [join(cfg.state_dir, 'state.json'), join(cfg.state_dir, 'journal.jsonl'), join(cfg.state_dir, 'PAUSE'), cfg.public_log];
  const before = watched.map(fileHash);
  return {
    cfg: { ...cfg, state_dir: stateDir, public_log: join(dir, 'public.json') } as KeeperConfig,
    realUnchanged: () => watched.every((p, i) => fileHash(p) === before[i]),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Wrap a connection so it can never broadcast. Call bind() with the keeper's accounts before its first send. */
export function dryRunConnection(real: Connection, stateDir: string) {
  let acc: DryAccounts | null = null;
  const delta = new Map<string, bigint>(); let supplyDelta = 0n;
  const synthetic = new Map<string, any>();
  const steps: DryStep[] = [];
  const blocked = { count: 0 };
  const intentOf = (stage: string) => {
    const s = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    return { intent: s.current?.stages?.[stage]?.intent ?? {}, swap: s.current?.swap };
  };
  const patch = (pk: PublicKey, ai: AccountInfo<Buffer> | null): AccountInfo<Buffer> | null => {
    if (!ai || !acc) return ai;
    const k = pk.toBase58(); const d = delta.get(k) ?? 0n;
    if (d !== 0n && ai.data.length >= 72) { const data = Buffer.from(ai.data); data.writeBigUInt64LE(data.readBigUInt64LE(64) + d, 64); return { ...ai, data }; }
    if (supplyDelta !== 0n && pk.equals(acc.mint) && ai.data.length >= 44) { const data = Buffer.from(ai.data); data.writeBigUInt64LE(data.readBigUInt64LE(36) + supplyDelta, 36); return { ...ai, data }; }
    return ai;
  };
  async function sendRaw(buf: Buffer | Uint8Array): Promise<string> {
    if (!acc) throw new Error('dry run: accounts not bound');
    const raw = Buffer.from(buf);
    const tx = Transaction.from(raw);
    const sig = bs58.encode(tx.signature!);
    const memo = tx.instructions.filter(i => i.programId.equals(MEMO_PROGRAM_ID)).map(i => i.data.toString()).find(d => d.startsWith('flywheel:')) ?? '';
    const stage = memo.split(':').at(-1) ?? 'unknown';
    const { intent, swap } = intentOf(stage);
    const tW = acc.tWsol.toBase58(), tM = acc.tMain.toBase58(), dW = acc.dWsol.toBase58();
    const eff = new Map<string, bigint>(); let burn = 0n;
    if (stage === 'claim_dbc') eff.set(tW, BigInt(intent.max_quote ?? '0'));
    else if (stage === 'claim_damm') eff.set(tW, BigInt(intent.claimable_before ?? '0'));
    else if (stage === 'dev') { eff.set(tW, -BigInt(intent.dev ?? '0')); eff.set(dW, BigInt(intent.dev ?? '0')); }
    else if (stage === 'swap') { eff.set(tW, -BigInt(intent.in_lamports ?? '0')); eff.set(tM, BigInt(swap?.quote_out_raw ?? '0')); }
    else if (stage === 'burn') { burn = BigInt(intent.amount ?? '0'); eff.set(tM, -burn); }
    const keys = new Set(tx.instructions.flatMap(i => i.keys.map(k => k.pubkey.toBase58())));
    const dependent = [tW, tM, dW].some(k => keys.has(k) && (delta.get(k) ?? 0n) !== 0n);
    const sim = await real.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true });
    const err = sim.value.err;
    const simulated: DryStep['simulated'] = !err ? 'ok' : dependent ? 'dependent' : 'error';
    const apply = simulated !== 'error';
    const order = [tW, tM, dW];
    const BASE = 10n ** 18n;
    const bal = (post: boolean) => order.map((k, i) => ({ accountIndex: i + 1, uiTokenAmount: { amount: (BASE + (post && apply ? eff.get(k) ?? 0n : 0n)).toString() } }));
    const fp = tx.feePayer ?? acc.feePayer!;
    synthetic.set(sig, {
      slot: sim.context.slot, blockTime: Math.floor(Date.now() / 1000),
      transaction: { message: { accountKeys: [fp, acc.tWsol, acc.tMain, acc.dWsol].map(pubkey => ({ pubkey })),
        instructions: apply && burn > 0n ? [{ programId: acc.mainProg.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : acc.mainProg, parsed: { type: 'burnChecked', info: { mint: acc.mainMint, tokenAmount: { amount: burn.toString() } } } }] : [] } },
      meta: { err: apply ? null : err, fee: 0, preTokenBalances: bal(false), postTokenBalances: bal(true), preBalances: [0, 0, 0, 0], postBalances: [0, 0, 0, 0] },
    });
    if (apply) { for (const [k, v] of eff) delta.set(k, (delta.get(k) ?? 0n) + v); supplyDelta -= burn; }
    steps.push({ stage, sig, simulated, units: sim.value.unitsConsumed, err: err ?? undefined, logs_tail: err ? (sim.value.logs ?? []).slice(-4) : undefined,
      effect: Object.fromEntries([...eff].map(([k, v]) => [k === tW ? 'treasury_wsol' : k === tM ? 'treasury_main' : 'dev_wsol', v.toString()])) });
    return sig;
  }
  const conn = new Proxy(real as any, {
    get(t, p) {
      if (p === 'sendRawTransaction') return sendRaw;
      if (p === 'sendTransaction' || p === 'sendEncodedTransaction') return async () => { blocked.count++; throw new Error('dry run: broadcast blocked'); };
      if (p === 'getSignatureStatuses') return async (sigs: string[], o?: any) => {
        const realSigs = sigs.filter(x => !synthetic.has(x));
        const r = realSigs.length ? (await t.getSignatureStatuses(realSigs, o)).value : [];
        let j = 0; return { context: { slot: 0 }, value: sigs.map(x => (synthetic.has(x) ? { slot: synthetic.get(x).slot, confirmations: null, err: synthetic.get(x).meta.err, confirmationStatus: 'confirmed' } : r[j++])) };
      };
      if (p === 'getParsedTransaction') return async (sig: string, o?: any) => (synthetic.has(sig) ? synthetic.get(sig) : t.getParsedTransaction(sig, o));
      if (p === 'getAccountInfo') return async (pk: PublicKey, c?: any) => patch(pk, await t.getAccountInfo(pk, c));
      if (p === 'getMultipleAccountsInfo') return async (pks: PublicKey[], c?: any) => (await t.getMultipleAccountsInfo(pks, c)).map((ai: any, i: number) => patch(pks[i], ai));
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Connection;
  return { conn, steps, blockedBroadcasts: () => blocked.count, bind: (a: DryAccounts) => { acc = a; } };
}
