// QA mainnet blocker #1: the hook authority reader (§12a, FW-23/FW-24) against REAL devnet account data, offline.
// Fixture: tests/fixtures/devnet_hook_authorities.json (public account data recorded read-only; ProgramData is its
// 45-byte header, which holds the upgrade authority). Negative cases must fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { HookClient, BPF_UPGRADEABLE, AuthorityReadError, parseProgramAccount, parseProgramDataAuthority, parseGlobalAuthority, readHookAuthorities, type AccountLike } from '../sdk/hook.js';
import { Launchpad } from '../sdk/launch.js';
import { startKeeper } from '../sdk/flywheel/keeper.js';
import { keeperStartChecks, launchConfigChecks, KeyRuleRefusal } from '../sdk/keyrules.js';
import { DEVNET_GENESIS } from '../sdk/cluster.js';
import type { KeeperConfig } from '../sdk/flywheel/config.js';

const FX = JSON.parse(readFileSync('tests/fixtures/devnet_hook_authorities.json', 'utf8'));
const PROGRAM = new PublicKey('FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz');
const EXPECTED = '9DVuoJSvxq97wyC9GmvB3GbAGfKywAvtK7VAXgiroFDu';   // devnet throwaway: upgrade + lift authority (see flywheel_dryrun_log.md)
const acc = (f: any): AccountLike & { executable: boolean } => ({ owner: new PublicKey(f.owner), data: Buffer.from(f.data_base64, 'base64'), executable: f.executable === true });
const hc = new HookClient(PROGRAM);
type Accts = Record<string, AccountLike | null>;
// The keeper's DBC source configs are present as DBC-owned data accounts, so a keeper start reaches the authority read.
const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const SOURCE_CONFIGS: Accts = Object.fromEntries((JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')) as KeeperConfig).sources.flatMap(s => (s.kind === 'dbc' ? [[s.config, { owner: DBC_PROGRAM, data: Buffer.alloc(0), executable: false } as AccountLike]] : [])));
const chain = (over: Accts = {}): Accts => ({ ...SOURCE_CONFIGS, [FX.program.pubkey]: acc(FX.program), [FX.program_data.pubkey]: acc(FX.program_data), [FX.global.pubkey]: acc(FX.global), ...over });
const conn = (a: Accts) => ({ getAccountInfo: async (pk: PublicKey) => a[pk.toBase58()] ?? null, getGenesisHash: async () => DEVNET_GENESIS });
const mutate = (f: any, fn: (b: Buffer) => Buffer, owner?: PublicKey): AccountLike => { const a = acc(f); return { owner: owner ?? a.owner, data: fn(Buffer.from(a.data)) }; };
const rejectsRead = (a: Accts, re: RegExp) => assert.rejects(readHookAuthorities(conn(a), PROGRAM), (e: any) => e instanceof AuthorityReadError && re.test(e.message));

test('fixture is the real devnet hook (addresses line up with the PDAs)', () => {
  assert.equal(FX.program.pubkey, PROGRAM.toBase58()); assert.equal(FX.program.owner, BPF_UPGRADEABLE.toBase58());
  assert.equal(FX.program_data.pubkey, hc.programDataPda().toBase58()); assert.equal(FX.global.pubkey, hc.globalPda().toBase58());
  assert.equal(FX.global.owner, PROGRAM.toBase58()); assert.equal(FX.program.genesis, DEVNET_GENESIS);
  assert.doesNotMatch(JSON.stringify(FX), /\[(\s*\d{1,3}\s*,){31,}/);   // no key arrays
});

test('real parser on recorded devnet data → upgrade and lift authority = expected pubkeys', async () => {
  assert.equal(parseProgramAccount(acc(FX.program), PROGRAM).toBase58(), FX.program_data.pubkey);
  assert.deepEqual(parseProgramDataAuthority(acc(FX.program_data)), { upgradeAuthority: EXPECTED, immutable: false });
  assert.equal(parseGlobalAuthority(acc(FX.global), PROGRAM), EXPECTED);
  assert.deepEqual(await readHookAuthorities(conn(chain()), PROGRAM), { upgradeAuthority: EXPECTED, liftAuthority: EXPECTED, upgradeImmutable: false });
});

test('both callers use the shared reader: Launchpad.hookAuthorities and startKeeper see the same values', async () => {
  const lp: any = { c: { connection: conn(chain()) }, hook: hc };
  assert.deepEqual(await Launchpad.prototype.hookAuthorities.call(lp), { upgradeAuthority: EXPECTED, liftAuthority: EXPECTED });
  const cfg = { ...JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')), pinned_pubkeys: undefined } as KeeperConfig;
  const k = await startKeeper(cfg, [], { loadKey: () => Keypair.generate(), connect: async () => conn(chain()) as any, log: () => {} });
  assert.ok(k);   // pinned 9DVu… matched the parsed chain data
});

test('immutable program (no upgrade authority) → null + immutable; fails closed in the §12a rules and the keeper pin check', async () => {
  const imm = mutate(FX.program_data, b => { b[12] = 0; return b.subarray(0, 13); });
  assert.deepEqual(parseProgramDataAuthority(imm), { upgradeAuthority: null, immutable: true });
  const a = await readHookAuthorities(conn(chain({ [FX.program_data.pubkey]: imm })), PROGRAM);
  assert.deepEqual(a, { upgradeAuthority: null, liftAuthority: EXPECTED, upgradeImmutable: true });
  assert.throws(() => launchConfigChecks('mainnet', Keypair.generate().publicKey.toBase58(), a), KeyRuleRefusal);
  assert.throws(() => keeperStartChecks('mainnet', { gas: Keypair.generate().publicKey.toBase58() }, a), KeyRuleRefusal);
  const cfg = { ...JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')), pinned_pubkeys: undefined } as KeeperConfig;
  await assert.rejects(startKeeper(cfg, [], { loadKey: () => Keypair.generate(), connect: async () => conn(chain({ [FX.program_data.pubkey]: imm })) as any, log: () => {} }),
    (e: any) => e instanceof KeyRuleRefusal && /do not match chain \(upgrade null/.test(e.message));
});

test('truncated or garbage accounts → AuthorityReadError (fail closed)', async () => {
  await rejectsRead(chain({ [FX.program.pubkey]: mutate(FX.program, b => b.subarray(0, 20)) }), /program account truncated/);
  await rejectsRead(chain({ [FX.program.pubkey]: mutate(FX.program, b => { b.writeUInt32LE(3, 0); return b; }) }), /tag 3 != 2/);
  await rejectsRead(chain({ [FX.program.pubkey]: mutate(FX.program, b => { Keypair.generate().publicKey.toBuffer().copy(b, 4); return b; }) }), /!= canonical/);
  await rejectsRead(chain({ [FX.program_data.pubkey]: mutate(FX.program_data, b => b.subarray(0, 30)) }), /ProgramData truncated \(30 < 45/);
  await rejectsRead(chain({ [FX.program_data.pubkey]: mutate(FX.program_data, b => b.subarray(0, 8)) }), /ProgramData truncated \(8 < 13/);
  await rejectsRead(chain({ [FX.program_data.pubkey]: mutate(FX.program_data, b => { b[12] = 7; return b; }) }), /option byte 7/);
  await rejectsRead(chain({ [FX.program_data.pubkey]: mutate(FX.program_data, () => Buffer.alloc(45, 0xab)) }), /tag/);
  await rejectsRead(chain({ [FX.global.pubkey]: mutate(FX.global, b => b.subarray(0, 20)) }), /Global truncated/);
  await rejectsRead(chain({ [FX.global.pubkey]: mutate(FX.global, b => { b.fill(0, 0, 8); return b; }) }), /Global undecodable/);
});

test('wrong owner → AuthorityReadError (fail closed)', async () => {
  await rejectsRead(chain({ [FX.program.pubkey]: mutate(FX.program, b => b, SystemProgram.programId) }), /program owner .* not the upgradeable loader/);
  await rejectsRead(chain({ [FX.program_data.pubkey]: mutate(FX.program_data, b => b, SystemProgram.programId) }), /ProgramData owner/);
  await rejectsRead(chain({ [FX.global.pubkey]: mutate(FX.global, b => b, Keypair.generate().publicKey) }), /Global owner .* not the hook program/);
});

test('missing accounts → AuthorityReadError; the keeper turns any read error into a start refusal', async () => {
  for (const k of [FX.program.pubkey, FX.program_data.pubkey, FX.global.pubkey]) await rejectsRead(chain({ [k]: null }), /not found/);
  const cfg = { ...JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')), pinned_pubkeys: undefined } as KeeperConfig;
  await assert.rejects(startKeeper(cfg, [], { loadKey: () => Keypair.generate(), connect: async () => conn(chain({ [FX.global.pubkey]: null })) as any, log: () => {} }),
    (e: any) => e instanceof KeyRuleRefusal && /cannot read hook authorities/.test(e.message));
});
