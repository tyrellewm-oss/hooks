// Mutation check for studio sign-in (sdk/studio_auth.ts and its use in app/server.ts). LOCAL, offline.
// Each mutant replaces one exact snippet in one source file, runs the studio tests and must make at least one test
// fail ("killed"). The file is restored after every mutant (also on error or Ctrl-C); a dirty tree at the end fails.
// Usage: node --import tsx scripts/mutants_studio_auth.ts [name-filter]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TESTS = ['tests/studio_auth.test.ts'];
const A = 'sdk/studio_auth.ts', SRV = 'app/server.ts';
type Mutant = { name: string; file: string; from: string; to: string };
const M: Mutant[] = [
  // allowlist
  { name: 'allowlist: bad entries skipped instead of stopping the server', file: A, from: "try { k = new PublicKey(raw); } catch { throw new Error(", to: "try { k = new PublicKey(raw); } catch { continue; throw new Error(" },
  { name: 'allowlist: any wallet may ask for a challenge', file: A, from: "    if (!this.allow.has(w)) throw new StudioAuthError(403, 'this wallet is not on the studio list');", to: '' },
  // fail closed
  { name: 'closed: an empty list opens the studio everywhere', file: A, from: 'this.open = allow.size === 0 && openWhenEmpty;', to: 'this.open = allow.size === 0;' },
  { name: 'closed: a configured list is ignored on local', file: A, from: 'this.open = allow.size === 0 && openWhenEmpty;', to: 'this.open = openWhenEmpty;' },
  { name: 'server: studio open on devnet too', file: SRV, from: "c.label, c.name === 'local');", to: 'c.label, true);' },
  // signature
  { name: 'sig: signature not checked', file: A, from: 'if (!verifyWalletSignature(p.wallet, new TextEncoder().encode(p.text), Buffer.from(signatureHex, \'hex\'))) throw', to: 'if (false) throw' },
  { name: 'sig: checked against the claimed wallet instead of the challenged one', file: A, from: "if (wallet !== p.wallet) throw new StudioAuthError(401, 'the signing wallet is not the one the sign-in was started for');", to: '' },
  // (no mutant for the 64-byte length check: node:crypto itself rejects any other ed25519 signature length, so changing
  //  the check cannot change behaviour; tests/studio_auth.test.ts asserts a 63-byte signature is refused)
  { name: 'sig: verify errors read as valid', file: A, from: '  } catch { return false; }\n}', to: '  } catch { return true; }\n}' },
  // challenge
  { name: 'challenge: reusable (not consumed)', file: A, from: '    this.pending.delete(nonce as string);\n', to: '' },
  { name: 'challenge: never expires', file: A, from: 'for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);', to: ';' },
  { name: 'challenge: expiry one tick late', file: A, from: 'for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);', to: 'for (const [k, v] of this.pending) if (v.expires < t) this.pending.delete(k);' },
  // session
  { name: 'session: never expires', file: A, from: 'for (const [k, v] of this.sessions) if (v.expires <= t) this.sessions.delete(k);', to: ';' },
  { name: 'session: expiry one tick late', file: A, from: 'for (const [k, v] of this.sessions) if (v.expires <= t) this.sessions.delete(k);', to: 'for (const [k, v] of this.sessions) if (v.expires < t) this.sessions.delete(k);' },
  { name: 'session: lasts 10x longer', file: A, from: 'export const SESSION_TTL_MS = 8 * 3600_000;', to: 'export const SESSION_TTL_MS = 80 * 3600_000;' },
  { name: 'session: sign-out does nothing', file: A, from: "if (typeof t === 'string') this.sessions.delete(t); }", to: '}' },
  { name: 'session: any token accepted', file: A, from: "const s = typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) ? this.sessions.get(token) : undefined;", to: 'const s = [...this.sessions.values()][0];' },
  // server wiring
  { name: 'server: create not protected', file: SRV, from: "      const who = studioCheck(req); if ('code' in who) return send(res, who.code, who.body);   // studio only", to: '' },
  { name: 'server: token-details edit not protected', file: SRV, from: "metadata: (mint, b) => { const who = studioCheck(req); if ('code' in who) return who; try {", to: 'metadata: (mint, b) => { try {' },
];

const filter = process.argv[2];
const files = new Map<string, string>();
const restoreAll = () => { for (const [f, src] of files) writeFileSync(f, src); };
process.on('SIGINT', () => { restoreAll(); process.exit(130); });
const run = () => spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=60000', ...TESTS], { encoding: 'utf8', maxBuffer: 64 << 20 });

const base = run();
if (base.status !== 0) { console.error('baseline FAILED: fix the tests first'); process.exit(1); }
let killed = 0, survived = 0, broken = 0;
for (const m of M.filter(x => !filter || x.name.includes(filter))) {
  const src = files.get(m.file) ?? readFileSync(m.file, 'utf8'); files.set(m.file, src);
  const n = src.split(m.from).length - 1;
  if (n !== 1) { console.log(`BROKEN    ${m.name} (snippet found ${n}x in ${m.file})`); broken++; continue; }
  try {
    writeFileSync(m.file, src.replace(m.from, m.to));
    const r = run();
    const fails = /^# fail (\d+)/m.exec(r.stdout)?.[1] ?? '?';
    if (r.status !== 0) { killed++; console.log(`KILLED    ${m.name} (${fails} failing)`); }
    else { survived++; console.log(`SURVIVED  ${m.name}`); }
  } finally { writeFileSync(m.file, src); }
}
restoreAll();
const changed = [...files].filter(([f, src]) => readFileSync(f, 'utf8') !== src).map(([f]) => f);
console.log(`\nmutants: ${killed} killed, ${survived} survived, ${broken} broken (of ${killed + survived + broken})`);
if (changed.length) { console.log(`NOT RESTORED: ${changed.join(', ')}`); process.exit(2); }
process.exit(survived || broken ? 1 : 0);
