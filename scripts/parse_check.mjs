// Parse check: every .ts file under sdk/, scripts/, app/, keeper/ and tests/ must parse (esbuild transform, no type
// check; a full tsc run is not part of CI). Catches a file broken by an edit, e.g. a statement swallowed by a comment.
// Usage: node scripts/parse_check.mjs [file ...]   (no arguments: the directories above)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';

const walk = d => (existsSync(d) ? readdirSync(d).flatMap(n => { const p = join(d, n); return n === 'node_modules' ? [] : statSync(p).isDirectory() ? walk(p) : /\.m?ts$/.test(n) ? [p] : []; }) : []);
const files = process.argv.length > 2 ? process.argv.slice(2) : ['sdk', 'scripts', 'app', 'keeper', 'tests'].flatMap(walk);
let bad = 0;
for (const f of files) {
  try { transformSync(readFileSync(f, 'utf8'), { loader: 'ts', format: 'esm', sourcefile: f, logLevel: 'silent' }); }
  catch (e) { bad++; console.log(`PARSE ERROR ${f}: ${(e.errors ?? []).map(x => `${x.location?.line ?? '?'}:${x.location?.column ?? '?'} ${x.text}`).join('; ') || e.message}`); }
}
console.log(`${files.length} files parsed, ${bad} failed`);
process.exit(bad ? 1 : 0);
