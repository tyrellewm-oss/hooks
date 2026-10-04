// scripts/qa_schedule.ts used `new HookClient()` (default devnet id on any cluster). It now goes through the same
// genesis-pinned HOOK_PROGRAM_ID resolver and executable check as the Launchpad gate. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DEVNET_GENESIS, MAINNET_GENESIS } from '../sdk/cluster.js';
import { HOOK_PROGRAM_ID_DEVNET, HookProgramPinRefusal, BPF_UPGRADEABLE } from '../sdk/hook.js';
import { ClusterCheckRefusal } from '../sdk/cluster_check.js';
import { resolveQaHookProgram } from '../sdk/launch.js';

const exe = { owner: BPF_UPGRADEABLE, executable: true };
const c = (genesis: string, url: string | undefined, accts: Record<string, any>) => ({ url, connection: { getGenesisHash: async () => genesis, getAccountInfo: async (k: PublicKey) => accts[k.toBase58()] ?? null } });
const env = (v?: string) => (v === undefined ? {} : { HOOK_PROGRAM_ID: v }) as NodeJS.ProcessEnv;

test('resolveQaHookProgram: devnet → pinned id (executable); override honoured on devnet; non-executable refused', async () => {
  assert.equal((await resolveQaHookProgram(c(DEVNET_GENESIS, undefined, { [HOOK_PROGRAM_ID_DEVNET]: exe }), env())).toBase58(), HOOK_PROGRAM_ID_DEVNET);
  const x = Keypair.generate().publicKey.toBase58();
  assert.equal((await resolveQaHookProgram(c(DEVNET_GENESIS, undefined, { [x]: exe }), env(x))).toBase58(), x);
  await assert.rejects(resolveQaHookProgram(c(DEVNET_GENESIS, undefined, { [HOOK_PROGRAM_ID_DEVNET]: { ...exe, executable: false } }), env()), ClusterCheckRefusal);
});
test('resolveQaHookProgram: mainnet genesis or a local validator without HOOK_PROGRAM_ID → refused (no devnet default)', async () => {
  await assert.rejects(resolveQaHookProgram(c(MAINNET_GENESIS, undefined, { [HOOK_PROGRAM_ID_DEVNET]: exe }), env()), HookProgramPinRefusal);
  await assert.rejects(resolveQaHookProgram(c(Keypair.generate().publicKey.toBase58(), 'http://127.0.0.1:8899', { [HOOK_PROGRAM_ID_DEVNET]: exe }), env()), HookProgramPinRefusal);
});
test('scripts/qa_schedule.ts builds its HookClient only from resolveQaHookProgram (no default-id HookClient)', () => {
  const src = readFileSync('scripts/qa_schedule.ts', 'utf8');
  assert.match(src, /new HookClient\(await resolveQaHookProgram\(c\)\)/);
  assert.doesNotMatch(src, /new HookClient\(\s*\)/);
});
