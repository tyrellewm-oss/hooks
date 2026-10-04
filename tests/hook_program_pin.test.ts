// HOOK_PROGRAM_ID gate (QA blocker #3, item 6): the hook program id is pinned by the RPC's genesis-based cluster class.
// devnet → override allowed; local (localhost URL + unknown genesis) → override allowed, required (no pin);
// mainnet/testnet → override must equal the pin, and there is no pin yet, so both refuse; unknown → refuse.
// Never a fallback to the devnet id. The gate runs before any tx is built. Offline.
import { test } from 'node:test';
import { launchCall } from './launch_key.js';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DEVNET_GENESIS, MAINNET_GENESIS, TESTNET_GENESIS } from '../sdk/cluster.js';
import { resolveHookProgramId, HookProgramPinRefusal, HOOK_PROGRAM_ID_PINS, HOOK_PROGRAM_ID_DEVNET, DEFAULT_PROGRAM_ID } from '../sdk/hook.js';
import { ClusterCheckRefusal } from '../sdk/cluster_check.js';
import { Launchpad, hookProgramFor, ConfigPinRefusal } from '../sdk/launch.js';

const other = () => Keypair.generate().publicKey.toBase58();
const LOCAL_GENESIS = other();
const env = (v?: string) => (v === undefined ? {} : { HOOK_PROGRAM_ID: v }) as NodeJS.ProcessEnv;
const LOCAL_URLS = ['http://127.0.0.1:8899', 'http://localhost:8899', 'http://[::1]:8899'];
const REMOTE_URLS = [undefined, 'https://rpc.example.com', 'http://127.0.0.1.example.com:8899'];
const refused = (re: RegExp) => (e: any) => e instanceof HookProgramPinRefusal && re.test(e.message);

test('pins: devnet is the deployed id; mainnet, testnet, local, unknown are unset; no env read at import', () => {
  assert.equal(HOOK_PROGRAM_ID_PINS.devnet, HOOK_PROGRAM_ID_DEVNET);
  for (const k of ['mainnet', 'testnet', 'local', 'unknown'] as const) assert.equal(HOOK_PROGRAM_ID_PINS[k], null, k);
  assert.ok(Object.isFrozen(HOOK_PROGRAM_ID_PINS));
  assert.equal(DEFAULT_PROGRAM_ID.toBase58(), HOOK_PROGRAM_ID_DEVNET);
});

test('devnet genesis: no override → pinned id; valid override accepted (any URL); invalid override refused', () => {
  for (const u of [...LOCAL_URLS, ...REMOTE_URLS]) {
    assert.equal(resolveHookProgramId(DEVNET_GENESIS, u, env()).programId.toBase58(), HOOK_PROGRAM_ID_DEVNET);
    const x = other(); const r = resolveHookProgramId(DEVNET_GENESIS, u, env(x));
    assert.equal(r.programId.toBase58(), x); assert.equal(r.override, x); assert.equal(r.clusterClass, 'devnet');
  }
  assert.throws(() => resolveHookProgramId(DEVNET_GENESIS, undefined, env('nope')), refused(/not a valid address/));
});

test('mainnet / testnet genesis (even on a localhost URL): override refused, and no override refused too (no pin, no devnet fallback)', () => {
  for (const g of [MAINNET_GENESIS, TESTNET_GENESIS]) for (const u of [...LOCAL_URLS, ...REMOTE_URLS]) {
    for (const v of [other(), HOOK_PROGRAM_ID_DEVNET]) assert.throws(() => resolveHookProgramId(g, u, env(v)), refused(/refusing HOOK_PROGRAM_ID override .*no pinned value/));
    assert.throws(() => resolveHookProgramId(g, u, env()), refused(/no pinned hook program id for cluster class '(mainnet|testnet)'/));
  }
});

test('localhost + unknown genesis → local: override accepted; no override refused (never the devnet id)', () => {
  for (const u of LOCAL_URLS) {
    const x = other(); const r = resolveHookProgramId(LOCAL_GENESIS, u, env(x));
    assert.equal(r.programId.toBase58(), x); assert.equal(r.clusterClass, 'local');
    assert.throws(() => resolveHookProgramId(LOCAL_GENESIS, u, env()), refused(/class 'local'.*set HOOK_PROGRAM_ID/));
  }
});

test('non-localhost + unknown genesis → refused, with or without an override', () => {
  for (const u of REMOTE_URLS) {
    assert.throws(() => resolveHookProgramId(LOCAL_GENESIS, u, env(other())), refused(/class 'unknown'/));
    assert.throws(() => resolveHookProgramId(LOCAL_GENESIS, u, env()), refused(/class 'unknown'/));
  }
});

test('genesis read error → refused (no fallback)', async () => {
  await assert.rejects(hookProgramFor({ connection: { getGenesisHash: async () => { throw new Error('503'); } } }, env()), refused(/cannot read the genesis hash/));
});

// ---------------- wiring: every tx-building Launchpad method runs the gate first
function fakeLp(genesis: string, url: string | undefined, accts: Map<string, any>, n: { built: number; reads: string[] }, requested?: PublicKey) {
  const build = async () => { n.built++; throw new Error('tx built'); };
  return {
    c: { name: 'devnet', label: 'DEVNET', url, connection: {
      getGenesisHash: async () => genesis,
      getAccountInfo: async (k: PublicKey) => { n.reads.push(k.toBase58()); return accts.get(k.toBase58()) ?? null; },
      getBalance: async () => { n.built++; return 0; },
    } },
    hook: { programId: Keypair.generate().publicKey },   // a stale placeholder must not be used
    requestedHookProgram: requested,
    configParams: () => ({}),
    dbc: { partner: { createConfigWithTransferHook: build }, pool: { swap2WithTransferHook: build }, migration: { migrateToDammV2: build }, state: { getPool: async () => { n.built++; return null; } } },
  };
}
const exe = { owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), executable: true, data: Buffer.alloc(36) };
const auth = { upgradeAuthority: other(), liftAuthority: other() };
const calls: [string, (lp: any) => Promise<unknown>][] = [
  ['launch', lp => launchCall(lp, Keypair.generate(), { name: 'x', symbol: 'X', steps: [], uncappedAfter: 1n, authorities: auth } as any)],
  ['swap', lp => Launchpad.prototype.swap.call(lp, Keypair.generate(), Keypair.generate().publicKey, 'buy', 1n, 'p', 1n)],
  ['buyExactIn', lp => Launchpad.prototype.buyExactIn.call(lp, Keypair.generate(), Keypair.generate().publicKey, 1n, 'p')],
  ['ensureGlobal', lp => Launchpad.prototype.ensureGlobal.call(lp, Keypair.generate(), Keypair.generate().publicKey)],
  ['hookAuthorities', lp => Launchpad.prototype.hookAuthorities.call(lp)],
  ['migrate', lp => Launchpad.prototype.migrate.call(lp, Keypair.generate(), Keypair.generate().publicKey)],
  ['status', lp => Launchpad.prototype.status.call(lp, Keypair.generate().publicKey)],
];

test('Launchpad methods on mainnet/testnet/unknown genesis refuse at the hook gate: 0 builds, 0 account reads', async () => {
  for (const [g, u] of [[MAINNET_GENESIS, 'http://127.0.0.1:8899'], [TESTNET_GENESIS, undefined], [LOCAL_GENESIS, 'https://rpc.example.com']] as const)
    for (const [name, call] of calls) {
      const n = { built: 0, reads: [] as string[] };
      // migrate resolves the DAMM v2 config first, which also has no testnet/unknown pin (ConfigPinRefusal)
      await assert.rejects(call(fakeLp(g, u, new Map(), n)), (e: any) => e instanceof HookProgramPinRefusal || (name === 'migrate' && g !== MAINNET_GENESIS && e instanceof ConfigPinRefusal), name);
      assert.equal(n.built, 0, name); assert.deepEqual(n.reads, [], name);
    }
});

test('Launchpad methods on devnet use the resolved id (pin or override), and refuse a non-executable one before building', async () => {
  const saved = process.env.HOOK_PROGRAM_ID;
  try {
    for (const ov of [undefined, other()]) {
      if (ov === undefined) delete process.env.HOOK_PROGRAM_ID; else process.env.HOOK_PROGRAM_ID = ov;
      const id = ov ?? HOOK_PROGRAM_ID_DEVNET;
      for (const [name, call] of calls) {
        const n = { built: 0, reads: [] as string[] };
        await assert.rejects(call(fakeLp(DEVNET_GENESIS, undefined, new Map([[id, { ...exe, executable: false }]]), n)), (e: any) => e instanceof ClusterCheckRefusal && /not executable/.test(e.message), name);
        assert.equal(n.built, 0, name); assert.deepEqual(n.reads, [id], name);
        const lp: any = fakeLp(DEVNET_GENESIS, undefined, new Map([[id, exe]]), n);
        await call(lp).catch(() => {});
        assert.equal(lp.hook.programId.toBase58(), id, name); assert.equal(lp.c.hookProgram.toBase58(), id, name);
      }
    }
  } finally { if (saved === undefined) delete process.env.HOOK_PROGRAM_ID; else process.env.HOOK_PROGRAM_ID = saved; }
});

test('an explicit constructor id that differs from the resolved one is refused before any build', async () => {
  const n = { built: 0, reads: [] as string[] };
  await assert.rejects(Launchpad.prototype.ensureGlobal.call(fakeLp(DEVNET_GENESIS, undefined, new Map([[HOOK_PROGRAM_ID_DEVNET, exe]]), n, Keypair.generate().publicKey) as any, Keypair.generate(), Keypair.generate().publicKey), refused(/differs from the resolved/));
  assert.equal(n.built, 0);
  const lp: any = fakeLp(DEVNET_GENESIS, undefined, new Map([[HOOK_PROGRAM_ID_DEVNET, exe]]), n, new PublicKey(HOOK_PROGRAM_ID_DEVNET));
  await Launchpad.prototype.hookAuthorities.call(lp).catch(() => {});
  assert.equal(lp.hook.programId.toBase58(), HOOK_PROGRAM_ID_DEVNET);
});

test('HOOK_PROGRAM_ID in the environment at import time does not change the offline default (no ungated env read)', async () => {
  const { execFileSync } = await import('node:child_process');
  const x = other();
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./sdk/hook.ts').then(m => console.log(m.DEFAULT_PROGRAM_ID.toBase58()))"], { env: { ...process.env, HOOK_PROGRAM_ID: x }, encoding: 'utf8' }).trim();
  assert.equal(out, HOOK_PROGRAM_ID_DEVNET); assert.notEqual(out, x);
});
