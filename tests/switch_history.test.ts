// app/switch_history.ts: the lift-only switch history scan (AC-29) behind /api/token. A fake connection stands in
// for the RPC: signatures per account, and transaction logs by signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { EVT } from '../sdk/hook.ts';
import { switchHistoryReader } from '../app/switch_history.ts';

const MINT = Keypair.generate().publicKey, OTHER = Keypair.generate().publicKey, SIGNER = Keypair.generate().publicKey;
const LIFT = Keypair.generate().publicKey, GLOBAL = Keypair.generate().publicKey;

/** A RestrictionsLifted event log line, laid out as sdk/hook.ts parseRestrictionsLifted reads it. */
function evtLog(scope: number, mint: PublicKey, newBps: number, slot: bigint, lifted = false): string {
  const b = Buffer.alloc(86);
  Buffer.from(EVT.RestrictionsLifted).copy(b, 0); b[8] = scope; mint.toBuffer().copy(b, 9);
  b.writeUInt16LE(0, 41); b.writeUInt16LE(newBps, 43); b[45] = lifted ? 1 : 0; b.writeBigUInt64LE(slot, 46); SIGNER.toBuffer().copy(b, 54);
  return `Program data: ${b.toString('base64')}`;
}
const TRADE = ['Program log: Instruction: TransferChecked'];

/** sigs: per account, newest first ({ err } = a failed tx). txs: logs, null = not served yet, Error = the fetch fails. */
function fakeConn(sigs: Map<PublicKey, { signature: string; err?: unknown }[]>, txs: Map<string, string[] | null | Error>) {
  const seen = { tx: [] as string[], maxInFlight: 0 };
  let inFlight = 0;
  const conn = {
    async getSignaturesForAddress(a: PublicKey) { return (sigs.get(a) ?? []).map(s => ({ signature: s.signature, err: s.err ?? null, slot: 0, memo: null, blockTime: null })); },
    async getTransaction(sig: string) {
      seen.tx.push(sig); inFlight++; seen.maxInFlight = Math.max(seen.maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 2)); inFlight--;
      const t = txs.get(sig);
      if (t instanceof Error) throw t;
      return t ? { meta: { logMessages: t } } : null;
    },
  };
  return { conn: conn as any, seen };
}
const link = (sig: string) => `tx:${sig}`;

test("this mint's and global switch uses among recent trades, newest first; failed txs and other mints skipped", async () => {
  const { conn, seen } = fakeConn(
    new Map([[LIFT, [{ signature: 's1' }, { signature: 's2' }, { signature: 's3', err: 'failed' }]], [GLOBAL, [{ signature: 's2' }, { signature: 's4' }, { signature: 's5' }, { signature: 's6' }]]]),
    new Map<string, string[] | null | Error>([['s1', TRADE], ['s2', [...TRADE, evtLog(1, MINT, 500, 100n)]], ['s4', [evtLog(0, PublicKey.default, 0, 200n, true)]], ['s5', [evtLog(1, OTHER, 900, 300n)]], ['s6', TRADE]]),
  );
  const h = await switchHistoryReader(conn, { link })(MINT, [LIFT, GLOBAL]);
  assert.deepEqual(h.map(e => [e.scope, e.slot, e.newMinCapBps, e.lifted, e.link]), [['global', '200', 0, true, 'tx:s4'], ['mint-lift', '100', 500, false, 'tx:s2']]);
  assert.equal(h[1].signer, SIGNER.toBase58());
  assert.deepEqual([...seen.tx].sort(), ['s1', 's2', 's4', 's5', 's6'], 'each signature fetched once; the failed tx never');
});

test('each transaction is fetched once: a later read only fetches new signatures', async () => {
  const lift = [{ signature: 'a1' }, { signature: 'a2' }];
  const { conn, seen } = fakeConn(new Map([[LIFT, lift], [GLOBAL, []]]), new Map<string, string[] | null | Error>([['a1', TRADE], ['a2', TRADE], ['a3', [evtLog(1, MINT, 300, 50n)]]]));
  const read = switchHistoryReader(conn, { link });
  assert.deepEqual(await read(MINT, [LIFT, GLOBAL]), []);
  lift.unshift({ signature: 'a3' });
  assert.equal((await read(MINT, [LIFT, GLOBAL])).length, 1);
  assert.deepEqual(seen.tx, ['a1', 'a2', 'a3']);
});

test('not served yet, or a failed fetch: tried again on the next read; a failed fetch fails the read', async () => {
  const txs = new Map<string, string[] | null | Error>([['b1', null], ['b2', new Error('429 Too Many Requests')]]);
  const { conn, seen } = fakeConn(new Map([[LIFT, [{ signature: 'b1' }]], [GLOBAL, [{ signature: 'b2' }]]]), txs);
  const read = switchHistoryReader(conn, { link });
  await assert.rejects(read(MINT, [LIFT, GLOBAL]), /429/);
  txs.set('b1', [evtLog(2, MINT, 700, 10n)]); txs.set('b2', TRADE);
  const h = await read(MINT, [LIFT, GLOBAL]);
  assert.deepEqual(h.map(e => e.scope), ['mint-raise']);
  assert.deepEqual(seen.tx.filter(s => s === 'b1').length, 2, 'b1 fetched again after it was not served');
  assert.deepEqual(seen.tx.filter(s => s === 'b2').length, 2, 'b2 fetched again after its fetch failed');
});

test('at most `parallel` transaction fetches at a time', async () => {
  const many = Array.from({ length: 23 }, (_, i) => ({ signature: `c${i}` }));
  const { conn, seen } = fakeConn(new Map([[LIFT, many], [GLOBAL, []]]), new Map(many.map(s => [s.signature, TRADE] as [string, string[]])));
  await switchHistoryReader(conn, { link, parallel: 5 })(MINT, [LIFT, GLOBAL]);
  assert.equal(seen.tx.length, 23);
  assert.ok(seen.maxInFlight <= 5 && seen.maxInFlight > 1, `in flight at once: ${seen.maxInFlight}`);
});
