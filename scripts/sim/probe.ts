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
