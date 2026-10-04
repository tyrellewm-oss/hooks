// Mutation check for ticket 8.3 (separate launch authority): the 16 spec mutants (M1-M16), some in more than one form.
// LOCAL, offline. Each mutant replaces exact snippets in one file and must make at least one test fail ("killed").
// Rust mutants rebuild the release .so (cargo build-sbf) before the tests; at the end the sources are restored, the
// .so is rebuilt and its sha256 must equal the pre-run one. A mutant that doesn't compile counts as BROKEN (not killed).
// Usage: node --import tsx scripts/mutants_launch_authority.ts [name-filter]   (needs cargo-build-sbf on PATH)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const LIB = 'programs/trenches-hook/src/lib.rs', STATE = 'programs/trenches-hook/src/state.rs';
const LAUNCH = 'sdk/launch.ts', HOOK = 'sdk/hook.ts', RULES = 'sdk/keyrules.ts', KEEPER = 'sdk/flywheel/keeper.ts', LA = 'sdk/launch_authority.ts', CLI = 'scripts/launch_authority.ts';
const SO = 'target/deploy/trenches_hook.so';
const PROGRAM_TESTS = ['tests/launch_authority.test.ts', 'tests/hook.test.ts'];
const TS_TESTS = ['tests/launch_authority_offchain.test.ts', 'tests/launch_authority.test.ts', 'tests/hook_authority_reader.test.ts', 'tests/flywheel.test.ts'];
/** `also`: a second file changed in the same mutant (e.g. a struct field plus its constructor). */
type Mutant = { name: string; file: string; edits: [string, string][]; also?: { file: string; edits: [string, string][] } };
const LAUNCH_EQ = 'require_keys_eq!(ctx.accounts.authority.key(), launch, HookError::Unauthorized);';
const LAUNCH_NEQ_ADMIN = 'require_keys_neq!(ctx.accounts.authority.key(), ctx.accounts.global.authority, HookError::Unauthorized);';
const LAUNCH_LEN = 'require!(g.data_len() == GLOBAL_V2_LEN, HookError::Unauthorized);';
const LAUNCH_READ = 'let launch = launch_authority_of(&g.try_borrow_data()?).ok_or(error!(HookError::Unauthorized))?;';
const M: Mutant[] = [
  { name: 'M1 launch-path signer not compared', file: LIB, edits: [[LAUNCH_EQ, '']] },
  { name: 'M2 launch compared against authority instead of bytes 42..74', file: LIB, edits: [[LAUNCH_EQ, 'require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.global.authority, HookError::Unauthorized);'], [LAUNCH_NEQ_ADMIN, '']] },
  { name: 'M3 launch accepts either key', file: LIB, edits: [[LAUNCH_EQ, 'require!(ctx.accounts.authority.key() == launch || ctx.accounts.authority.key() == ctx.accounts.global.authority, HookError::Unauthorized);'], [LAUNCH_NEQ_ADMIN, '']] },
  { name: 'M4 not-set check skipped (unset launch key lets any signer launch)', file: LIB, edits: [[LAUNCH_LEN, ''], [LAUNCH_READ, 'let launch = launch_authority_of(&g.try_borrow_data()?).unwrap_or(ctx.accounts.authority.key());']] },
  { name: 'M4b all-zero tail read as a key', file: STATE, edits: [['if b.iter().all(|x| *x == 0) { return None; }', '']] },
  { name: 'M5 admin check removed from migrate_global_v2', file: LIB, edits: [['require_keys_eq!(ctx.accounts.authority.key(), admin, HookError::Unauthorized);', '']] },
  { name: 'M5b admin check removed from set_launch_authority', file: LIB, edits: [['#[account(mut, seeds = [GLOBAL_SEED], bump = global.bump, has_one = authority @ HookError::Unauthorized)]\n    pub global: Account<\'info, Global>,\n}\n\n#[derive(Accounts)]\npub struct TransferHook', '#[account(mut, seeds = [GLOBAL_SEED], bump = global.bump)]\n    pub global: Account<\'info, Global>,\n}\n\n#[derive(Accounts)]\npub struct TransferHook']] },
  { name: 'M6 != authority removed at migrate', file: LIB, edits: [['require_keys_neq!(launch_authority, admin, HookError::Unauthorized);', '']] },
  { name: 'M6b != authority removed at rotation', file: LIB, edits: [['require_keys_neq!(new_launch_authority, admin, HookError::Unauthorized);', '']] },
  { name: 'M7 rotation does not take effect (old key still the launch key)', file: LIB, edits: [['g.try_borrow_mut_data()?[GLOBAL_V1_LEN..GLOBAL_V2_LEN].copy_from_slice(new_launch_authority.as_ref());', '']] },
  { name: 'M8a keyrules: keeper key == launch not checked', file: RULES, edits: [["    if (auth.launchAuthority && k === auth.launchAuthority) problems.push(`keeper key '${role}' ${short(k)} is the hook launch authority`);\n", '']] },
  { name: 'M8b keyrules: feeClaimer == launch not checked', file: RULES, edits: [['  if (auth.launchAuthority && feeClaimer === auth.launchAuthority) problems.push(`feeClaimer ${short(feeClaimer)} is the hook launch authority`);\n', '']] },
  { name: 'M8c keyrules: launch == upgrade / lift not checked', file: RULES, edits: [['  if (auth.launchAuthority && auth.launchAuthority === auth.upgradeAuthority) p.push', '  if (false) p.push'], ['  if (auth.launchAuthority && auth.launchAuthority === auth.liftAuthority) p.push', '  if (false) p.push']] },
  { name: 'M8d keyrules: unknown launch key accepted off devnet', file: RULES, edits: [["(!isTestCluster(cluster) && !auth.launchAuthority ?", '(false ?']] },
  { name: 'M8e keeper: launch pin not compared with the chain', file: KEEPER, edits: [[' || launch !== cfg.hook_launch_authority)', ')']] },
  { name: 'M8f buildCreatePoolTx passes the payer as the hook authority', file: LAUNCH, edits: [['authority: keys.launchAuthority, mint: keys.mint', 'authority: keys.payer, mint: keys.mint']] },
  { name: 'M8g buildCreatePoolTx skips the chain launch-key check', file: LAUNCH, edits: [['  assertLaunchSigner(keys.launchAuthority, auth);   // before any build', '']] },
  { name: 'M8h launch signer may be the lift key', file: LAUNCH, edits: [['  if (auth.liftAuthority && k === auth.liftAuthority) throw', '  if (false) throw']] },
  { name: 'M9 realloc clobbers bytes 0..42 (writes at offset 8)', file: LIB, edits: [['g.try_borrow_mut_data()?[GLOBAL_V1_LEN..GLOBAL_V2_LEN].copy_from_slice(launch_authority.as_ref());', 'g.try_borrow_mut_data()?[8..40].copy_from_slice(launch_authority.as_ref());']] },
  { name: 'M9b realloc zero-fills the whole account', file: LIB, edits: [['g.try_borrow_mut_data()?[GLOBAL_V1_LEN..GLOBAL_V2_LEN].copy_from_slice(launch_authority.as_ref());', 'g.try_borrow_mut_data()?.fill(0); g.try_borrow_mut_data()?[GLOBAL_V1_LEN..GLOBAL_V2_LEN].copy_from_slice(launch_authority.as_ref());']] },
  { name: 'M10 migrate overwrites on a second run', file: LIB, edits: [['require!(g.data_len() == GLOBAL_V1_LEN, HookError::ConfigFrozen);', '']] },
  { name: 'M11 launch_authority added to the Rust Global struct', file: STATE, edits: [['    pub lifted: bool,\n    pub bump: u8,\n}\n\n/// Global as created', '    pub lifted: bool,\n    pub bump: u8,\n    pub launch_authority: Pubkey,\n}\n\n/// Global as created']],
    also: { file: LIB, edits: [['let g = Global { authority, lifted: false, bump };', 'let g = Global { authority, lifted: false, bump, launch_authority: Pubkey::default() };']] } },
  { name: 'M12 lift_global write-back zeroes bytes 42..74', file: LIB, edits: [['            lifted: true, slot, signer: ctx.accounts.authority.key(),\n        });\n        Ok(())\n    }\n\n    /// Lift-only switch (per mint): remove', '            lifted: true, slot, signer: ctx.accounts.authority.key(),\n        });\n        { let gi = ctx.accounts.global.to_account_info(); let mut d = gi.try_borrow_mut_data()?; let n = d.len(); d[GLOBAL_V1_LEN.min(n)..].fill(0); }\n        Ok(())\n    }\n\n    /// Lift-only switch (per mint): remove']] },
  { name: 'M13 lift/raise gated on admin or launch key', file: LIB, edits: [['pub struct LiftMint<\'info> {\n    pub authority: Signer<\'info>,\n    #[account(seeds = [GLOBAL_SEED], bump = global.bump, has_one = authority @ HookError::Unauthorized)]', 'pub struct LiftMint<\'info> {\n    pub authority: Signer<\'info>,\n    #[account(seeds = [GLOBAL_SEED], bump = global.bump, constraint = authority.key() == global.authority || Some(authority.key()) == launch_authority_of(&global.to_account_info().data.borrow()) @ HookError::Unauthorized)]']] },
  { name: 'M14 set_launch_authority(current) accepted', file: LIB, edits: [['require!(current != Some(new_launch_authority), HookError::ConfigFrozen);', '']] },
  { name: 'M15 TS decoder requires exactly 74 bytes', file: HOOK, edits: [['if (b.length !== GLOBAL_V1_LEN && b.length < GLOBAL_V2_LEN) throw', 'if (b.length !== GLOBAL_V2_LEN) throw']] },
  { name: 'M15b TS decoder ignores the tail', file: HOOK, edits: [['launchAuthority: tail && tail.some(x => x !== 0) ? new PublicKey(tail) : null', 'launchAuthority: null']] },
  { name: 'M15c TS decoder accepts any length', file: HOOK, edits: [['if (b.length !== GLOBAL_V1_LEN && b.length < GLOBAL_V2_LEN) throw', 'if (false) throw']] },
  { name: 'M16 migrate script defaults to send', file: CLI, edits: [["send: argv.includes('--send')", "send: !argv.includes('--dry-run')"]] },
  { name: 'M16b tool sends on a dry run', file: LA, edits: [['  if (!o.send) {', '  if (o.send === false) {']] },
  { name: 'M16d dry run passes a legacy Transaction with a config (throws on a real Connection)', file: LA, edits: [['conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {', 'conn.simulateTransaction(tx, {']] },
  { name: 'M16c tool accepts a mainnet genesis', file: LA, edits: [["if (cls !== 'devnet' && cls !== 'local') throw", "if (cls === 'unknown') throw"]] },
];

const filter = process.argv[2];
const sha = () => createHash('sha256').update(readFileSync(SO)).digest('hex');
const build = () => spawnSync('cargo', ['build-sbf', '--manifest-path', 'programs/trenches-hook/Cargo.toml', '--sbf-out-dir', 'target/deploy'], { encoding: 'utf8', maxBuffer: 64 << 20 });
const test = (files: string[]) => spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=60000', ...files], { encoding: 'utf8', maxBuffer: 64 << 20 });
const originals = new Map<string, string>();
const restoreAll = () => { for (const [f, src] of originals) writeFileSync(f, src); };
process.on('SIGINT', () => { restoreAll(); process.exit(130); });

const soBefore = sha();
for (const files of [PROGRAM_TESTS, TS_TESTS]) if (test(files).status !== 0) { console.error(`baseline FAILED (${files.join(' ')}): fix the tests first`); process.exit(1); }
let killed = 0, survived = 0, broken = 0;
const apply = (file: string, edits: [string, string][]) => {
  const src = originals.get(file) ?? readFileSync(file, 'utf8'); originals.set(file, src);
  let out = src;
  for (const [from, to] of edits) { const n = out.split(from).length - 1; if (n !== 1) return { src, out: null, bad: `snippet found ${n}x in ${file}` }; out = out.replace(from, to); }
  return { src, out, bad: '' };
};
for (const m of M.filter(x => !filter || x.name.includes(filter))) {
  const parts = [{ file: m.file, ...apply(m.file, m.edits) }, ...(m.also ? [{ file: m.also.file, ...apply(m.also.file, m.also.edits) }] : [])];
  const bad = parts.find(p => p.bad)?.bad;
  if (bad) { console.log(`BROKEN    ${m.name} (${bad})`); broken++; continue; }
  const rust = parts.some(p => p.file.endsWith('.rs'));
  try {
    for (const p of parts) writeFileSync(p.file, p.out!);
    if (rust) { const b = build(); if (b.status !== 0) { console.log(`BROKEN    ${m.name} (does not compile)`); broken++; continue; } }
    const r = test(rust ? PROGRAM_TESTS : TS_TESTS);
    const fails = /^# fail (\d+)/m.exec(r.stdout)?.[1] ?? '?';
    if (r.status !== 0) { killed++; console.log(`KILLED    ${m.name} (${fails} failing)`); } else { survived++; console.log(`SURVIVED  ${m.name}`); }
  } finally { for (const p of parts) writeFileSync(p.file, p.src); }
}
restoreAll();
const changed = [...originals].filter(([f, src]) => readFileSync(f, 'utf8') !== src).map(([f]) => f);
if (build().status !== 0) { console.log('REBUILD FAILED after restore'); process.exit(2); }
const soOk = sha() === soBefore;
console.log(`\nmutants: ${killed} killed, ${survived} survived, ${broken} broken (of ${killed + survived + broken}); release .so restored: ${soOk ? 'yes (sha256 unchanged)' : 'NO'}`);
if (changed.length || !soOk) { console.log(`NOT RESTORED: ${changed.join(', ')}`); process.exit(2); }
process.exit(survived || broken ? 1 : 0);
