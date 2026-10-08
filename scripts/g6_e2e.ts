// LOCAL end-to-end check for G6 (per-owner cap) through the real Meteora DBC program on a local validator.
// The attack: a curve buy whose output goes to a SECOND token account of the same wallet (not its ATA).
// Run against the old program it should land (the bypass); against G6 it must fail with cap=0.
//   pnpm tsx scripts/g6_e2e.ts [--expect bypass|g6]   (default g6; LOCAL only)
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAccountLen, ExtensionType, createInitializeAccount3Instruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import { resolveCluster, type Cluster } from '../sdk/cluster.js';
import { loadOrCreate } from '../sdk/keys.js';
import { Launchpad, sendTx, type TxRecord } from '../sdk/launch.js';
import { LOCAL_DEMO } from '../sdk/schedules.js';
import { TOKEN_2022 } from '../sdk/hook.js';

const argv = process.argv.slice(2);
const expect = argv.includes('--expect') ? argv[argv.indexOf('--expect') + 1] : 'g6';
if (expect !== 'g6' && expect !== 'bypass') { console.error('--expect g6|bypass'); process.exit(2); }
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const SUPPLY = 1_000_000_000n * 1_000_000n;
const pct = (p: number) => (SUPPLY * BigInt(Math.round(p * 100))) / 10_000n;
const DECIMALS = 6;

const rows: { step: string; want: 'ok' | 'fail'; rec: TxRecord; pass: boolean; detail: string }[] = [];
function check(step: string, want: 'ok' | 'fail', rec: TxRecord, extra: (r: TxRecord) => string = () => '') {
  const pass = want === 'ok' ? rec.ok : !rec.ok && rec.hookError === 'WalletCapExceeded';
  const detail = `${rec.ok ? 'landed' : `failed ${rec.hookError ?? rec.err ?? ''}`}${rec.capHit ? ` cap=${rec.capHit.cap} balance=${rec.capHit.balance}` : ''} ${extra(rec)}`.trim();
  rows.push({ step, want, rec, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [want ${want}] ${step}: ${detail}  sig=${rec.sig.slice(0, 12)}`);
}
async function fund(c: Cluster, to: PublicKey, sol: number) {
  const s = await c.connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL); await c.connection.confirmTransaction(s, 'confirmed');
}
async function waitSlot(c: Cluster, target: bigint) {
  for (;;) { const s = BigInt(await c.connection.getSlot('confirmed')); if (s >= target) return s; await new Promise(r => setTimeout(r, 1000)); }
}
async function balance(c: Cluster, a: PublicKey) {
  const r = await c.connection.getTokenAccountBalance(a, 'confirmed').catch(() => null); return r ? BigInt(r.value.amount) : 0n;
}
/** A second (non-ATA) Token-2022 account of `mint` owned by `owner`. */
async function secondAccount(c: Cluster, payer: Keypair, mint: PublicKey, owner: PublicKey) {
  const acc = Keypair.generate(); const len = getAccountLen([ExtensionType.TransferHookAccount]);
  const rent = await c.connection.getMinimumBalanceForRentExemption(len);
  const r = await sendTx(c, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: acc.publicKey, space: len, lamports: rent, programId: TOKEN_2022 }),
    createInitializeAccount3Instruction(acc.publicKey, mint, owner, TOKEN_2022)), [payer, acc], 'g6: create second token account');
  if (!r.ok) throw new Error('second account: ' + r.err);
  return acc.publicKey;
}
/** Real DBC buy (swap2_with_transfer_hook, ExactOut) with the base output redirected from the buyer's ATA to `dest`. */
async function buyInto(lp: Launchpad, c: Cluster, buyer: Keypair, pool: PublicKey, mint: PublicKey, dest: PublicKey, tokens: bigint, purpose: string) {
  const bal = BigInt(await c.connection.getBalance(buyer.publicKey));
  let max = bal - 30_000_000n; if (max > 2_000_000_000n) max = 2_000_000_000n;
  const tx: Transaction = await lp.dbc.pool.swap2WithTransferHook({ owner: buyer.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.ExactOut, amountOut: new BN(tokens.toString()), maximumAmountIn: new BN(max.toString()) } as any);
  const ata = getAssociatedTokenAddressSync(mint, buyer.publicKey, true, TOKEN_2022);
  const swaps = tx.instructions.filter(ix => ix.programId.equals(DBC));
  if (swaps.length !== 1) throw new Error(`expected 1 DBC ix, got ${swaps.length}`);
  let hits = 0;
  swaps[0].keys = swaps[0].keys.map(k => (k.pubkey.equals(ata) ? (hits++, { ...k, pubkey: dest }) : k));
  if (dest.equals(ata) ? hits !== 0 && hits !== 1 : hits !== 1) throw new Error(`output account not found exactly once in the DBC ix (${hits})`);
  return sendTx(c, tx, [buyer], purpose);
}
function moveIx(lp: Launchpad, mint: PublicKey, src: PublicKey, dst: PublicKey, owner: PublicKey, amt: bigint, withHook: boolean) {
  const ix = createTransferCheckedInstruction(src, mint, dst, owner, amt, DECIMALS, [], TOKEN_2022);
  if (withHook) ix.keys.push(...lp.hook.transferHookExtraAccounts(mint));
  return new Transaction().add(ix);
}

(async () => {
  const c = await resolveCluster('local');
  console.log(`cluster ${c.label} ${c.url}  expect=${expect}`);
  const lp = new Launchpad(c);
  const deployer = loadOrCreate('local', 'local'); await fund(c, deployer.publicKey, 50);
  const launchKey = loadOrCreate('local', 'launch');
  const A = Keypair.generate(), B = Keypair.generate();   // in-memory only, never written
  await fund(c, A.publicKey, 10); await fund(c, B.publicKey, 10);
  await lp.ensureGlobal(deployer, deployer.publicKey);
  await lp.ensureLaunchAuthority(deployer, launchKey.publicKey);
  const threshold = 1;
  const rec = await lp.launch(deployer, { name: 'G6 E2E Test', symbol: 'G6T', steps: LOCAL_DEMO.steps, uncappedAfter: LOCAL_DEMO.uncappedAfter, migrationQuoteThresholdSol: threshold }, launchKey);
  const pool = new PublicKey(rec.pool), mint = new PublicKey(rec.mint);
  const st0 = await lp.status(mint); const L = BigInt(st0.launchSlot);
  console.log(`launched mint=${mint.toBase58()} pool=${pool.toBase58()} launchSlot=${L} hook=${st0.transferHookProgram}`);
  const ataA = getAssociatedTokenAddressSync(mint, A.publicKey, true, TOKEN_2022);
  const a2 = await secondAccount(c, deployer, mint, A.publicKey);
  const attack = expect === 'g6' ? 'fail' : 'ok';

  // --- step 1 (cap 1%)
  check('A buys 0.5% into its ATA (real curve buy)', 'ok', await lp.swap(A, pool, 'buy', pct(0.5), 'g6: A buy 0.5% ATA'));
  check('A buys +0.6% into its ATA (over 1% cap)', 'fail', await lp.swap(A, pool, 'buy', pct(0.6), 'g6: A buy +0.6% ATA'));
  check('ATTACK: A buys 0.9% through the curve into its SECOND account', attack, await buyInto(lp, c, A, pool, mint, a2, pct(0.9), 'g6: A buy 0.9% -> second account'));
  check('ATTACK: A buys 1 base unit into its second account', attack, await buyInto(lp, c, A, pool, mint, a2, 1n, 'g6: A buy 1 unit -> second account'));
  check('ATTACK: A moves 0.05% from its ATA to its second account', attack, await sendTx(c, moveIx(lp, mint, ataA, a2, A.publicKey, pct(0.05), true), [A], 'g6: A ATA -> second'));
  check('A sells 0.2% from its ATA into the curve', 'ok', await lp.swap(A, pool, 'sell', pct(0.2), 'g6: A sell 0.2%'));
  check('B (another wallet) buys 0.9% into its ATA', 'ok', await lp.swap(B, pool, 'buy', pct(0.9), 'g6: B buy 0.9%'));
  check('A buys into its ATA by explicit routing (control for the redirect helper)', 'ok', await buyInto(lp, c, A, pool, mint, ataA, pct(0.1), 'g6: A buy 0.1% ATA via helper'));
  const heldA = (await balance(c, ataA)) + (await balance(c, a2));
  console.log(`  A holds ${heldA} across ATA + second account (cap 1% = ${pct(1)}): ${heldA <= pct(1) ? 'within one cap' : 'OVER one cap'}`);
  rows.push({ step: 'A total across both accounts within one cap (step 1)', want: expect === 'g6' ? 'ok' : 'fail', rec: { ok: heldA <= pct(1) } as any,
    pass: expect === 'g6' ? heldA <= pct(1) : heldA > pct(1), detail: `held=${heldA} cap=${pct(1)}` });

  // --- step 2 (cap 2%)
  await waitSlot(c, L + 150n);
  check('step 2: A buys up to 1.9% in its ATA', 'ok', await lp.swap(A, pool, 'buy', pct(1.9) - (await balance(c, ataA)), 'g6: A top up ATA to 1.9%'));
  check('step 2 ATTACK: A buys 1% into its second account', attack, await buyInto(lp, c, A, pool, mint, a2, pct(1), 'g6: step2 A buy 1% -> second'));

  // --- after the ramp: no cap, second account works
  await waitSlot(c, L + LOCAL_DEMO.uncappedAfter);
  check('after ramp: A buys 0.5% into its second account', 'ok', await buyInto(lp, c, A, pool, mint, a2, pct(0.5), 'g6: after ramp A buy -> second'));
  check('after ramp: A moves 0.1% ATA -> second account', 'ok', await sendTx(c, moveIx(lp, mint, ataA, a2, A.publicKey, pct(0.1), true), [A], 'g6: after ramp ATA -> second'));

  // --- graduation + migration
  check('graduation: B fills the curve', 'ok', await lp.buyExactIn(B, pool, BigInt(Math.round(threshold * 1.25 * LAMPORTS_PER_SOL)), 'g6: fill curve'));
  const st2 = await lp.status(mint);
  console.log(`  after fill: transferHookProgram=${st2.transferHookProgram}`);
  rows.push({ step: 'graduation removes the hook from the mint', want: 'ok', rec: {} as any, pass: st2.transferHookProgram === null, detail: `transferHookProgram=${st2.transferHookProgram}` });
  await fund(c, new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'), 1);
  check('migration to DAMM v2', 'ok', await lp.migrate(deployer, pool));
  const B2 = await secondAccount(c, deployer, mint, B.publicKey);
  const ataB = getAssociatedTokenAddressSync(mint, B.publicKey, true, TOKEN_2022);
  check('after migration: B moves 5% to its second account (no hook)', 'ok', await sendTx(c, moveIx(lp, mint, ataB, B2, B.publicKey, pct(5), false), [B], 'g6: post-migration move'));

  const failed = rows.filter(r => !r.pass);
  console.log(`\n${rows.length - failed.length}/${rows.length} checks as expected (expect=${expect})`);
  console.log('JSON ' + JSON.stringify({ expect, mint: mint.toBase58(), pool: pool.toBase58(), rows: rows.map(r => ({ step: r.step, want: r.want, pass: r.pass, detail: r.detail, sig: r.rec.sig })) }));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
