// QA mainnet blocker #4: the dev wallet only RECEIVES the 15% payout, so the keeper must not load or require a dev
// keypair. Config: `dev_payout` (pubkey). A dev keypair path (`keys.dev`) is refused before any key file is opened.
// Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { checkKeyConfig, loadConfig, KEEPER_KEY_ROLES, type KeeperConfig } from '../sdk/flywheel/config.js';
import { startKeeper, preflightOffline, Keeper, initState, newRun, type KeySet } from '../sdk/flywheel/keeper.js';
import { KeyRuleRefusal } from '../sdk/keyrules.js';
import { HookClient, ACC, BPF_UPGRADEABLE, DBC_PROGRAM_ID } from '../sdk/hook.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TDT = JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')) as KeeperConfig;
const FW15 = JSON.parse(readFileSync('keeper/devnet.fw15.json', 'utf8')) as KeeperConfig;
const pk = () => Keypair.generate().publicKey.toBase58();
const refused = (re: RegExp) => (e: any) => e instanceof KeyRuleRefusal && re.test(e.message);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** Key loader that records every name it is asked for; the three signing keys only. */
function loader() {
  const ks: KeySet = { claim: Keypair.generate(), treasury: Keypair.generate(), gas: Keypair.generate() };
  const byName: Record<string, Keypair> = { [TDT.keys.claim_signer]: ks.claim, [TDT.keys.treasury]: ks.treasury, [TDT.keys.gas]: ks.gas };
  const asked: string[] = [];
  return { ks, asked, loadKey: (n: string) => { asked.push(n); const k = byName[n]; if (!k) throw new Error(`no key file ${n}`); return k; } };
}
/** A well-formed devnet hook as the chain would show it (executable program → ProgramData with an upgrade authority,
 *  Global with a lift authority) plus the DBC source configs, so the keeper's start-up reads all pass. */
const UPG = pk(), LIFT = pk();
const HOOK = new PublicKey(TDT.hook_program);
const PD = PublicKey.findProgramAddressSync([HOOK.toBuffer()], BPF_UPGRADEABLE)[0];
const CHAIN = new Map<string, any>([
  [HOOK.toBase58(), { owner: BPF_UPGRADEABLE, executable: true, data: Buffer.concat([Buffer.from([2, 0, 0, 0]), PD.toBuffer()]) }],
  [PD.toBase58(), { owner: BPF_UPGRADEABLE, executable: false, data: Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(8), Buffer.from([1]), new PublicKey(UPG).toBuffer()]) }],
  [new HookClient(HOOK).globalPda().toBase58(), { owner: HOOK, executable: false, data: Buffer.concat([ACC.Global, new PublicKey(LIFT).toBuffer(), Buffer.from([0, 255])]) }],
  ...TDT.sources.flatMap(x => (x.kind === 'dbc' ? [[x.config, { owner: DBC_PROGRAM_ID, executable: false, data: Buffer.alloc(0) }] as [string, any]] : [])),
]);
const fakeConn = (n: { connects: number }) => async () => { n.connects++; return { getGenesisHash: async () => DEVNET_GENESIS, getAccountInfo: async (k: PublicKey) => CHAIN.get(k.toBase58()) ?? null } as unknown as Connection; };
const startable = (o: Partial<KeeperConfig> = {}): KeeperConfig => ({ ...clone(TDT), pinned_pubkeys: undefined, hook_upgrade_authority: UPG, hook_lift_authority: LIFT, ...o });

test('devnet keeper configs: signing keys only (no dev keypair path, no pinned dev), dev payout as a pubkey', () => {
  for (const [c, dev] of [[TDT, '74KbNAK9d3GAKSMKqA7fVzkLGcTcJStS9T3jiKmDs4nn'], [FW15, 'Fyf3yL8DTiYR1ho2bdbUTro1Uq5d5Qss5KjYkqSgfVdP']] as const) {
    assert.deepEqual(Object.keys(c.keys).sort(), [...KEEPER_KEY_ROLES].sort());
    assert.deepEqual(Object.keys(c.pinned_pubkeys ?? {}).sort(), [...KEEPER_KEY_ROLES].sort());
    assert.equal(c.dev_payout, dev);   // same dev wallet as before, now as a payout address
    checkKeyConfig(c);
    assert.doesNotMatch(JSON.stringify(c), /fw_dev|fw15_dev/);
  }
});

test('the keeper starts without any dev keypair: only the three signing key files are opened', async () => {
  const L = loader(); const n = { connects: 0 };
  const cfg = startable();
  const k = await startKeeper(cfg, [], { loadKey: L.loadKey, connect: fakeConn(n), log: () => {} });
  assert.deepEqual(L.asked, [cfg.keys.claim_signer, cfg.keys.treasury, cfg.keys.gas]);
  assert.equal(n.connects, 1);
  assert.deepEqual(Object.keys(k.keys).sort(), ['claim', 'gas', 'treasury']);
  assert.ok(k.dWsol.equals(getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(cfg.dev_payout), false, TOKEN_PROGRAM_ID)));
});

test('a config with a dev keypair path (keys.dev) is refused before any key file is opened or any connection made', async () => {
  const L = loader(); const n = { connects: 0 };
  const cfg = startable(); (cfg.keys as any).dev = 'fw_dev';
  await assert.rejects(startKeeper(cfg, [], { loadKey: L.loadKey, connect: fakeConn(n), log: () => {} }), refused(/keys\.dev is set.*never signs as the dev wallet.*dev_payout/));
  assert.deepEqual(L.asked, []); assert.equal(n.connects, 0);
  assert.throws(() => preflightOffline(cfg, L.ks), refused(/keys\.dev/));
  // the CLI path (loadConfig) refuses the same file
  const dir = mkdtempSync(join(tmpdir(), 'fw-cfg-')); const f = join(dir, 'c.json'); writeFileSync(f, JSON.stringify(cfg));
  assert.throws(() => loadConfig(f, {}), refused(/keys\.dev/));
  writeFileSync(f, JSON.stringify(startable())); assert.equal(loadConfig(f, {}).cfg.dev_payout, TDT.dev_payout);
});

test('other key-config errors are refused offline: pinned dev, unknown roles, missing role, missing/invalid/off-curve dev_payout', () => {
  const cases: [string, (c: any) => void, RegExp][] = [
    ['pinned_pubkeys.dev', c => (c.pinned_pubkeys = { dev: pk() }), /pinned_pubkeys\.dev is not used/],
    ['unknown key role', c => (c.keys.dev_wallet = 'x'), /unknown key role keys\.dev_wallet/],
    ['unknown pinned role', c => (c.pinned_pubkeys = { payout: pk() }), /unknown pinned_pubkeys\.payout/],
    ['missing gas key', c => delete c.keys.gas, /keys\.gas is missing/],
    ['missing treasury key', c => (c.keys.treasury = ''), /keys\.treasury is missing/],
    ['no keys section', c => delete c.keys, /no keys section/],
    ['missing dev_payout', c => delete c.dev_payout, /dev_payout .* is missing/],
    ['invalid dev_payout', c => (c.dev_payout = 'not-an-address'), /dev_payout is not a valid address/],
    ['off-curve dev_payout', c => (c.dev_payout = PublicKey.findProgramAddressSync([Buffer.from('x')], TOKEN_PROGRAM_ID)[0].toBase58()), /off-curve/],
  ];
  for (const [name, mut, re] of cases) { const c = startable(); mut(c); assert.throws(() => checkKeyConfig(c), refused(re), name); }
  checkKeyConfig(startable());
});

test('dev_payout equal to any loaded keeper key is refused (each role)', async () => {
  for (const role of KEEPER_KEY_ROLES) {
    const L = loader(); const n = { connects: 0 };
    const key = role === 'claim_signer' ? L.ks.claim : L.ks[role];
    await assert.rejects(startKeeper(startable({ dev_payout: key.publicKey.toBase58() }), [], { loadKey: L.loadKey, connect: fakeConn(n), log: () => {} }), refused(new RegExp(`dev_payout is the keeper's '${role}' key`)));
    assert.equal(n.connects, 0);
  }
});

test('FW-23 covers every key the keeper loads: each signing role equal to a hook authority refuses on mainnet', async () => {
  for (const role of KEEPER_KEY_ROLES) for (const which of ['upgrade', 'lift'] as const) {
    const L = loader(); const n = { connects: 0 };
    const key = (role === 'claim_signer' ? L.ks.claim : L.ks[role]).publicKey.toBase58();
    const cfg = startable({ cluster: 'mainnet', hook_upgrade_authority: which === 'upgrade' ? key : pk(), hook_lift_authority: which === 'lift' ? key : pk() });
    await assert.rejects(startKeeper(cfg, [], { loadKey: L.loadKey, connect: fakeConn(n), log: () => {} }), refused(new RegExp(`keeper key '${role}' .* ${which} authority`)), `${role}/${which}`);
    assert.equal(n.connects, 0);
  }
});

test('pinned pubkeys still apply to every signing role (each mismatch refuses)', () => {
  for (const role of KEEPER_KEY_ROLES) {
    const L = loader();
    const pins = { claim_signer: L.ks.claim.publicKey.toBase58(), treasury: L.ks.treasury.publicKey.toBase58(), gas: L.ks.gas.publicKey.toBase58() };
    preflightOffline(startable({ pinned_pubkeys: pins }), L.ks);
    assert.throws(() => preflightOffline(startable({ pinned_pubkeys: { ...pins, [role]: pk() } }), L.ks), refused(new RegExp(`key '${role}' does not match pinned pubkey`)), role);
  }
});

test('the dev payout goes to the configured pubkey: 15% transfer from treasury wSOL to dev_payout wSOL, signed by treasury only', async () => {
  const L = loader(); const dev = pk();
  const dir = mkdtempSync(join(tmpdir(), 'fw-dev-'));
  const cfg = startable({ dev_payout: dev, state_dir: join(dir, 'state'), public_log: join(dir, 'pub.json') });
  const k = new Keeper(cfg, [], {} as Connection, L.ks, [], () => {});
  let got: any = null;
  (k as any).sendStage = async (_s: any, _run: any, stage: string, ixs: any[], signers: Keypair[], intent: any) => { got = { stage, ixs, signers, intent }; throw new Error('captured'); };
  const s: any = initState(cfg); s.unsplit_lamports = '10000000';
  await assert.rejects((k as any).split(s, newRun('r', [], 'running', '')), /captured/);
  assert.equal(got.stage, 'dev'); assert.equal(got.intent.dev, '1500000'); assert.equal(got.intent.buyback, '8500000');
  const ix = got.ixs[0];
  assert.ok(ix.programId.equals(TOKEN_PROGRAM_ID));
  assert.ok(ix.keys[0].pubkey.equals(k.tWsol));                                                                   // source: treasury wSOL
  assert.ok(ix.keys[2].pubkey.equals(getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(dev), false, TOKEN_PROGRAM_ID)));   // dest: dev_payout wSOL
  assert.ok(ix.keys[3].pubkey.equals(L.ks.treasury.publicKey));                                                    // owner/signer: treasury
  assert.deepEqual(got.signers.map((x: Keypair) => x.publicKey.toBase58()), [L.ks.treasury.publicKey.toBase58()]);
});
