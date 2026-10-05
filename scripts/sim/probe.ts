// CI diagnostic: walk the litesvm setup one step at a time (the shared Env setup aborts with std::bad_alloc on Linux).
import { LiteSVM } from 'litesvm';
import { Keypair, PublicKey } from '@solana/web3.js';
import { programBytes, DBC_PROGRAM, HOOK_PROGRAM } from './programs.js';

const step = (n: string) => console.log('[probe]', n);
const hook = await programBytes(HOOK_PROGRAM); step(`hook bytes ${hook.length}`);
const dbc = await programBytes(DBC_PROGRAM); step(`dbc bytes ${dbc.length}`);
const svm = new LiteSVM(); step('new LiteSVM');
const k = Keypair.generate();
svm.airdrop(k.publicKey, 1_000_000_000n); step('airdrop');
svm.addProgram(Keypair.generate().publicKey, hook); step('addProgram(hook bytes) at a random id');
svm.addProgram(HOOK_PROGRAM, hook); step('addProgram(hook bytes) at the hook id');
const pd = PublicKey.findProgramAddressSync([HOOK_PROGRAM.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
const acc = svm.getAccount(pd); step(`programData account: ${acc ? `${acc.data.length} bytes owner ${new PublicKey(acc.owner).toBase58()}` : 'none'}`);
const prog = svm.getAccount(HOOK_PROGRAM); step(`program account: ${prog ? `${prog.data.length} bytes owner ${new PublicKey(prog.owner).toBase58()} exec ${prog.executable}` : 'none'}`);
svm.addProgram(DBC_PROGRAM, dbc); step('addProgram(dbc)');
import { SystemProgram, Transaction } from '@solana/web3.js';
const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 }));
tx.recentBlockhash = svm.latestBlockhash(); tx.feePayer = k.publicKey; tx.sign(k);
const r: any = svm.sendTransaction(tx); step('sendTransaction(transfer)');
step(`logs: ${r.logs().length}`);
if (process.env.PROBE_RETURN_DATA) { r.returnData(); step('returnData() read'); }
console.log('[probe] OK');

// replicate tests/env.ts Env setup line by line
import { Env } from '../../tests/env.js';
import { BPF_UPGRADEABLE } from '../../sdk/hook.js';
const svm2 = new LiteSVM(); step('2: new LiteSVM');
const file = `.sim-programs/${HOOK_PROGRAM.toBase58()}.so`;
svm2.addProgramFromFile(HOOK_PROGRAM, file); step('2: addProgramFromFile');
const pd2 = PublicKey.findProgramAddressSync([HOOK_PROGRAM.toBuffer()], BPF_UPGRADEABLE)[0];
const acc2: any = svm2.getAccount(pd2); step(`2: getAccount pd: keys ${Object.keys(acc2 ?? {}).join(',')} lamports=${acc2?.lamports}`);
const data = Buffer.from(acc2.data); data[12] = 1; Keypair.generate().publicKey.toBuffer().copy(data, 13);
svm2.setAccount(pd2, { ...acc2, data, owner: BPF_UPGRADEABLE }); step('2: setAccount spread');
const env = new Env(file, HOOK_PROGRAM); step('3: new Env');
const admin = Keypair.generate(), launch = Keypair.generate(); env.fund(admin.publicKey); env.fund(launch.publicKey);
const g = env.initGlobal(admin.publicKey); step(`3: initGlobal ok=${g.ok}`);
const m = env.migrateGlobal(admin, launch.publicKey); step(`3: migrateGlobal ok=${m.ok}`);
console.log('[probe] ENV OK');
