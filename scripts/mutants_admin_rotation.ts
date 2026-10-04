// Mutation check for ticket 8.3b (rotate_admin): spec mutants M1-M8.
// LOCAL, offline. Each mutant replaces one exact snippet and must fail tests/admin_rotation*.test.ts.
// Rust mutants rebuild the release .so. Sources are restored and the .so rebuilt; its sha256 must match the start.
// Usage: node --import tsx scripts/mutants_admin_rotation.ts [name-filter]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const LIB = 'programs/trenches-hook/src/lib.rs';
const LA = 'sdk/launch_authority.ts';
const CLI = 'scripts/launch_authority.ts';
const SO = 'target/deploy/trenches_hook.so';
const TESTS = ['tests/admin_rotation.test.ts', 'tests/admin_rotation_offchain.test.ts'];
const SIGNER = 'require!(ctx.accounts.authority.key() == admin, HookError::Unauthorized);';
const LAUNCH_NEQ = 'require_keys_neq!(new_authority, launch, HookError::ConfigFrozen);';
const ADMIN_NEQ = 'require_keys_neq!(new_authority, admin, HookError::ConfigFrozen);';
const LEN = 'require!(d.len() == GLOBAL_V2_LEN, HookError::ConfigFrozen);';
const LAUNCH_READ = 'let launch = launch_authority_of(&d).ok_or(error!(HookError::ConfigFrozen))?;';
const COPY = 'g.try_borrow_mut_data()?[8..40].copy_from_slice(new_authority.as_ref());';
const CANON = 'require_keys_eq!(g.key(), canonical, HookError::Unauthorized);';
const OWNER = 'require_keys_eq!(*g.owner, crate::ID, HookError::Unauthorized);';
const DISC = 'require!(d.len() >= 8 && &d[..8] == Global::DISCRIMINATOR, HookError::Unauthorized);';
type Mutant = { name: string; file: string; edits: [string, string][] };
const M: Mutant[] = [
  { name: 'M1 admin signer check removed', file: LIB, edits: [[SIGNER, '']] },
  { name: 'M2 new compared to the admin instead of the launch key', file: LIB, edits: [[LAUNCH_NEQ, ADMIN_NEQ]] },
  { name: 'M3 new == launch key accepted', file: LIB, edits: [[LAUNCH_NEQ, '']] },
  { name: 'M4 42-byte account or a zero launch tail accepted', file: LIB, edits: [[LEN, ''], [LAUNCH_READ, 'let launch = launch_authority_of(&d).unwrap_or(Pubkey::default());']] },
  { name: 'M5 rotate also clears the launch-key tail', file: LIB, edits: [[COPY, COPY + ' g.try_borrow_mut_data()?[42..74].fill(0);']] },
  { name: 'M6 new == current admin accepted', file: LIB, edits: [[ADMIN_NEQ, '']] },
  { name: 'M7 write skipped so the old admin still works', file: LIB, edits: [[COPY, '']] },
  { name: 'M8a script defaults to send', file: CLI, edits: [["send: argv.includes('--send')", "send: !argv.includes('--dry-run')"]] },
  { name: 'M8b tool sends on a dry run', file: LA, edits: [['  if (!o.send) {', '  if (o.send === false) {']] },
  { name: 'M8c tool accepts a mainnet genesis', file: LA, edits: [["if (cls !== 'devnet' && cls !== 'local') throw", "if (cls === 'unknown') throw"]] },
  { name: 'X1 canonical address check removed', file: LIB, edits: [[CANON, '']] },
  { name: 'X2 owner check removed', file: LIB, edits: [[OWNER, '']] },
  { name: 'X3 discriminator check removed', file: LIB, edits: [[DISC, '']] },
];

const filter = process.argv[2];
const sha = () => createHash('sha256').update(readFileSync(SO)).digest('hex');
const build = () => spawnSync('cargo', ['build-sbf', '--manifest-path', 'programs/trenches-hook/Cargo.toml', '--sbf-out-dir', 'target/deploy'], { encoding: 'utf8', maxBuffer: 64 << 20 });
const test = () => spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=60000', ...TESTS], { encoding: 'utf8', maxBuffer: 64 << 20 });
const originals = new Map<string, string>();
const restoreAll = () => { for (const [f, src] of originals) writeFileSync(f, src); };
process.on('SIGINT', () => { restoreAll(); process.exit(130); });

const soBefore = sha();
if (test().status !== 0) { console.error('baseline FAILED: fix the tests first'); process.exit(1); }
let killed = 0, survived = 0, broken = 0;
for (const m of M.filter(x => !filter || x.name.includes(filter))) {
  const src = originals.get(m.file) ?? readFileSync(m.file, 'utf8'); originals.set(m.file, src);
  let out = src; let bad = '';
  for (const [from, to] of m.edits) {
    const n = out.split(from).length - 1;
    if (n !== 1) { bad = `snippet found ${n}x`; break; }
    out = out.replace(from, to);
  }
  if (bad) { console.log(`BROKEN    ${m.name} (${bad})`); broken++; continue; }
  const rust = m.file.endsWith('.rs');
  try {
    writeFileSync(m.file, out);
    if (rust) { const b = build(); if (b.status !== 0) { console.log(`BROKEN    ${m.name} (does not compile)`); broken++; continue; } }
    const t = test();
    if (t.status !== 0) { console.log(`KILLED    ${m.name}`); killed++; }
    else { console.log(`SURVIVED  ${m.name}`); survived++; }
  } finally { writeFileSync(m.file, src); }
}
restoreAll();
if (M.some(m => m.file.endsWith('.rs') && (!filter || m.name.includes(filter)))) {
  const b = build();
  if (b.status !== 0 || sha() !== soBefore) { console.error('restore build failed or sha changed'); process.exit(1); }
}
console.log(`killed ${killed}  survived ${survived}  broken ${broken}`);
process.exit(survived || broken ? 1 : 0);
