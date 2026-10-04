// launch() generates the DBC config and mint keypairs locally only on devnet/local genesis. Elsewhere (mainnet, testnet,
// unknown) it refuses before generating anything; the mint keypair then belongs to the signing side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DEVNET_GENESIS, MAINNET_GENESIS, TESTNET_GENESIS } from '../sdk/cluster.js';
import { HOOK_PROGRAM_ID_DEVNET } from '../sdk/hook.js';
import { Launchpad, LaunchKeygenRefusal, assertLaunchKeygenAllowed, launchKeypairsFor } from '../sdk/launch.js';

const BPF = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const HOOK = new PublicKey(HOOK_PROGRAM_ID_DEVNET);

/** Counts Keypair.generate() calls made while `f` runs. */
async function countGenerates<T>(f: () => T | Promise<T>): Promise<{ r: T | Error; generates: number }> {
  const orig = Keypair.generate; let generates = 0;
  (Keypair as any).generate = function (...a: any[]) { generates++; return (orig as any).apply(this, a); };
  try { return { r: await f(), generates }; } catch (e: any) { return { r: e, generates }; } finally { (Keypair as any).generate = orig; }
}

test('keygen guard: mainnet / testnet / unknown refuse with 0 generates', async () => {
  for (const cls of ['mainnet', 'testnet', 'unknown'] as const) {
    const { r, generates } = await countGenerates(() => launchKeypairsFor(cls));
    assert.ok(r instanceof LaunchKeygenRefusal && new RegExp(`cluster class '${cls}'`).test(r.message), `${cls}: expected LaunchKeygenRefusal, got ${String((r as any)?.message ?? r)}`);
    assert.equal(generates, 0, `${cls}: no keypair may be generated`);
    assert.throws(() => assertLaunchKeygenAllowed(cls), LaunchKeygenRefusal);
  }
});
test('keygen guard: devnet and local generate the config and mint keypairs (2 generates, distinct keys)', async () => {
  for (const cls of ['devnet', 'local'] as const) {
    const { r, generates } = await countGenerates(() => launchKeypairsFor(cls));
    assert.equal(generates, 2, cls);
    const k = r as { config: Keypair; mint: Keypair };
    assert.equal(k.config.publicKey.equals(k.mint.publicKey), false, `${cls}: config and mint keys must differ`);
    assert.doesNotThrow(() => assertLaunchKeygenAllowed(cls));
  }
});
test('launch(): devnet genesis and a local validator reach keypair generation (2 generates) and the config build', async () => {
  const saved = process.env.HOOK_PROGRAM_ID;
  try {
    for (const [cls, genesis, url, env] of [['devnet', DEVNET_GENESIS, 'https://rpc.invalid', undefined], ['local', 'LocalGenesis1111111111111111111111111111111', 'http://127.0.0.1:8899', HOOK_PROGRAM_ID_DEVNET]] as const) {
      if (env === undefined) delete process.env.HOOK_PROGRAM_ID; else process.env.HOOK_PROGRAM_ID = env;
      let built = 0;
      const lp: any = {
        c: { name: cls, label: cls, url, connection: { getGenesisHash: async () => genesis, getAccountInfo: async (k: PublicKey) => (k.equals(HOOK) ? { owner: BPF, executable: true } : null) } },
        hook: { programId: HOOK }, configParams: () => ({}),
        dbc: { partner: { createConfigWithTransferHook: async () => { built++; throw new Error('tx built'); } } },
      };
      const auth = { upgradeAuthority: Keypair.generate().publicKey.toBase58(), liftAuthority: Keypair.generate().publicKey.toBase58() };
      const deployer = Keypair.generate();
      const { r, generates } = await countGenerates(() => Launchpad.prototype.launch.call(lp, deployer, { name: 'x', symbol: 'X', steps: [], uncappedAfter: 1n, authorities: auth } as any));
      assert.match(String((r as any)?.message), /tx built/, cls); assert.equal(generates, 2, cls); assert.equal(built, 1, cls);
    }
  } finally { if (saved === undefined) delete process.env.HOOK_PROGRAM_ID; else process.env.HOOK_PROGRAM_ID = saved; }
});
test('launch(): mainnet / testnet / unknown genesis refuse with 0 generates and 0 builds (today the hook gate stops them first)', async () => {
  for (const [genesis, url] of [[MAINNET_GENESIS, 'https://rpc.invalid'], [TESTNET_GENESIS, 'https://rpc.invalid'], ['UnknownGenesis1111111111111111111111111111', 'https://rpc.invalid']]) {
    let built = 0;
    const lp: any = {
      c: { name: 'devnet', label: 'x', url, connection: { getGenesisHash: async () => genesis, getAccountInfo: async () => ({ owner: BPF, executable: true }) } },
      hook: { programId: HOOK }, configParams: () => ({}),
      dbc: { partner: { createConfigWithTransferHook: async () => { built++; throw new Error('tx built'); } } },
    };
    const auth = { upgradeAuthority: Keypair.generate().publicKey.toBase58(), liftAuthority: Keypair.generate().publicKey.toBase58() };
    const deployer = Keypair.generate();
    const { r, generates } = await countGenerates(() => Launchpad.prototype.launch.call(lp, deployer, { name: 'x', symbol: 'X', steps: [], uncappedAfter: 1n, authorities: auth } as any));
    assert.ok(r instanceof Error && /refusing/.test(r.message), `${genesis}: expected a refusal, got ${String((r as any)?.message ?? r)}`);
    assert.equal(generates, 0, `${genesis}: 0 generates`); assert.equal(built, 0, `${genesis}: 0 builds`);
  }
});
test('launch() creates keypairs only through launchKeypairsFor (no other Keypair.generate in sdk/launch.ts), after the guard', () => {
  const src = readFileSync(new URL('../sdk/launch.ts', import.meta.url), 'utf8');
  const calls = src.split('\n').filter(l => /Keypair\.generate\(/.test(l));
  assert.deepEqual(calls.map(l => l.trim()), ['return { config: Keypair.generate(), mint: Keypair.generate() };'], 'only the guarded helper may generate keypairs');
  const helper = src.slice(src.indexOf('export function launchKeypairsFor'), src.indexOf('export function launchKeypairsFor') + 300);
  assert.ok(helper.indexOf('assertLaunchKeygenAllowed(cls)') >= 0 && helper.indexOf('assertLaunchKeygenAllowed(cls)') < helper.indexOf('Keypair.generate('), 'the guard must run before generating');
  const launch = src.slice(src.indexOf('async launch('));
  assert.ok(launch.indexOf('assertLaunchKeygenAllowed(gate.clusterClass)') >= 0 && launch.indexOf('assertLaunchKeygenAllowed(gate.clusterClass)') < launch.indexOf('this.hookAuthorities()'), 'launch() must check the genesis class right after the gate, before any read');
  assert.ok(launch.indexOf('launchKeypairsFor(gate.clusterClass)') > 0, 'launch() must pass the genesis class (not the Cluster name)');
});
