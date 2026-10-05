// CI probe: does litesvm 1.5 survive an in-program account resize (migrate_global_v2), which aborts 0.8 on Linux?
// Uses 1.5's Kit-style API directly (string addresses, { messageBytes, signatures } transactions).
import { LiteSVM } from 'litesvm';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { HookClient, BPF_UPGRADEABLE } from '../../sdk/hook.js';
import { programBytes, HOOK_PROGRAM } from './programs.js';

const step = (n: string) => console.log('[probe15]', n);
const a = (k: PublicKey) => k.toBase58() as any;
const svm: any = new LiteSVM(); step('new LiteSVM (1.5)');
const hook = new HookClient(HOOK_PROGRAM);
svm.addProgram(a(HOOK_PROGRAM), await programBytes(HOOK_PROGRAM)); step('addProgram(hook)');
const upgrade = Keypair.generate(), admin = Keypair.generate(), launch = Keypair.generate();
for (const k of [upgrade, admin]) svm.airdrop(a(k.publicKey), 10_000_000_000n);
step('airdrops');
// make `upgrade` the program's upgrade authority (initialize_global requires it)
const pd = hook.programDataPda();
const acc = svm.getAccount(a(pd)); step(`programData exists=${acc.exists} keys=${Object.keys(acc).join(',')}`);
const data = new Uint8Array(acc.data); data[12] = 1; data.set(upgrade.publicKey.toBytes(), 13);
svm.setAccount({ ...acc, data }); step('programData patched');

function send(ixs: any[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash(); tx.feePayer = signers[0].publicKey; tx.sign(...signers);
  const sigs: Record<string, Uint8Array> = {};
  for (const s of tx.signatures) sigs[s.publicKey.toBase58()] = new Uint8Array(s.signature!);
  const r = svm.sendTransaction({ messageBytes: new Uint8Array(tx.serializeMessage()), signatures: sigs });
  svm.expireBlockhash();
  const failed = typeof r.err === 'function';
  const logs: string[] = (failed ? r.meta().logs() : r.logs()) ?? [];
  return { ok: !failed, logs };
}
const g = send([hook.initializeGlobal(upgrade.publicKey, admin.publicKey)], [upgrade]);
step(`initialize_global ok=${g.ok} ${g.ok ? '' : g.logs.slice(-3).join(' | ')}`);
const m = send([hook.migrateGlobalV2(upgrade.publicKey, admin.publicKey, launch.publicKey)], [upgrade, admin]);
step(`migrate_global_v2 (account resize) ok=${m.ok} ${m.ok ? '' : m.logs.slice(-3).join(' | ')}`);
const after = svm.getAccount(a(hook.globalPda())); step(`Global length after: ${after.data.length}`);
console.log('[probe15] OK');
void BPF_UPGRADEABLE;
