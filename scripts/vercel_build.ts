// Build the hosted, read-only site for Vercel as a prebuilt deployment (.vercel/output, Build Output API v3):
//   node --import tsx scripts/vercel_build.ts   then   vercel deploy --prebuilt
// Only what this script copies is uploaded: web/dist as static files, one bundled API function, and the public data the
// API reads (page copy, mint registry, keeper public logs, launch records, token details). No key file is read, and the
// audit at the end refuses to finish if any output file looks like a keypair or contains the local RPC API key.
import { build } from 'esbuild';
import { execSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const OUT = '.vercel/output', FN = join(OUT, 'functions/api.func');
const run = (cmd: string, cwd = '.') => { if (spawnSync(cmd, { cwd, shell: true, stdio: 'inherit' }).status !== 0) throw new Error(`failed: ${cmd}`); };

rmSync(OUT, { recursive: true, force: true });

// 1. front end
run('npx -y pnpm@10 exec vite build', 'web');
cpSync('web/dist', join(OUT, 'static'), { recursive: true });

// 2. the API as one ESM function at app/index.mjs: modules that find files relative to themselves (sdk/registry.ts:
//    ../keeper/registry.json) resolve inside the function. VERCEL is defined so the bundle is always in hosted mode.
await build({
  entryPoints: ['app/vercel.ts'], outfile: join(FN, 'app/index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
  define: { 'process.env.VERCEL': '"1"', 'process.env.HOOKD_COMMIT': JSON.stringify(execSync('git rev-parse --short HEAD').toString().trim()) },
  // esbuild serves only the classic page's /capMath.js (never reached hosted); the other two are optional ws addons
  external: ['esbuild', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" },
  logLevel: 'warning',
});
writeFileSync(join(FN, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs22.x', handler: 'app/index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }, null, 2));

// 3. public data, at the same relative paths (the function root is its working directory)
const list = (d: string, keep: (f: string) => boolean) => (existsSync(d) ? readdirSync(d).filter(keep).map(f => `${d}/${f}`) : []);
const data = ['research/page_content.json', 'keeper/registry.json',
  ...list('flywheel', f => /^devnet-.*\.json$/.test(f)), ...list('launches/devnet', f => f.endsWith('.json')), ...list('metadata/devnet', () => true)];
for (const f of data) { mkdirSync(join(FN, dirname(f)), { recursive: true }); cpSync(f, join(FN, f)); }

// 4. routes: static files first, /api/* to the function, every other path to the single-page app
writeFileSync(join(OUT, 'config.json'), JSON.stringify({ version: 3, routes: [
  { handle: 'filesystem' }, { src: '^/api(/.*)?$', dest: '/api' }, { src: '^/(.*)$', dest: '/index.html' },
] }, null, 2));

// 5. audit every file that will be uploaded
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(OUT);
const rpc = existsSync('.devnet-keys/helius_rpc.txt') ? readFileSync('.devnet-keys/helius_rpc.txt', 'utf8').trim() : '';
const apiKey = /api-key=([^&\s]+)/.exec(rpc)?.[1] ?? '';
const keypairArray = /\[\s*(\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/;
const bad: string[] = [];
for (const f of files) {
  const rel = relative(OUT, f).replace(/\\/g, '/');
  if (/devnet-keys|local-keys|keypair|(^|\/)id\.json$|\.env/.test(rel)) bad.push(`${rel}: key-like path`);
  if (!/\.(json|m?js|html|css|txt|svg|map)$/.test(rel)) continue;
  const text = readFileSync(f, 'utf8');
  if (apiKey && text.includes(apiKey)) bad.push(`${rel}: contains the local RPC API key`);
  if (keypairArray.test(text)) bad.push(`${rel}: keypair-like 64-byte array`);
}
if (bad.length) { console.error(`REFUSED: ${bad.join('\n')}`); process.exit(1); }
const size = files.reduce((a, f) => a + statSync(f).size, 0);
console.log(`audit ok: ${files.length} files, ${(size / 1e6).toFixed(1)} MB, no key files, no keypair arrays${apiKey ? ', no RPC API key' : ''}`);
console.log(`function: ${(statSync(join(FN, 'app/index.mjs')).size / 1e6).toFixed(1)} MB bundle + ${data.length} data files: ${data.join(', ')}`);
