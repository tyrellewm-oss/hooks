// One-click local run of the whole site (Windows, macOS, Linux). Started by start-hookd.cmd (double-click) or
// `node scripts/start.mjs`. It checks the tools, pulls the branch you are on, installs packages when they change, checks
// the devnet keys, launch records and RPC, then starts the backend (5175), the site (5176) and the chart indexer, opens
// the browser, and keeps following the branch: pulled site changes reload the page, pulled backend changes restart the
// backend. The launcher's own checks are read-only; it never deploys, airdrops or runs the keeper. The backend it starts
// sends devnet transactions only when you act on the site (trades you sign in your wallet; studio launches, which the
// admin key pays for, when STUDIO_WALLETS is set).
//
//   start-hookd.cmd               live devnet data if the keys and RPC work on this PC, else sample data
//   start-hookd.cmd --demo        sample tokens only (no keys, no backend)
//   start-hookd.cmd --live        live devnet data, stop if anything is missing
//   start-hookd.cmd --preview     the built site served by the backend on 5175, as it would be hosted
//   start-hookd.cmd --check       only run the checks and print the report
//   --no-follow --no-indexer --no-browser
// Settings live in .env (copied from .env.example on first run; gitignored). Real environment variables win.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const LOGS = join(ROOT, 'logs');   // logs/*.log are gitignored
const PIDFILE = join(LOGS, 'launcher.pid');
const WIN = process.platform === 'win32';
const API_PORT = 5175, SITE_PORT = 5176;
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';   // sdk/cluster.ts
const FOLLOW_EVERY_S = 30;
process.chdir(ROOT);   // every service reads keeper/, launches/, .index/ relative to the repo

// ---------- output
const C = process.stdout.isTTY ? { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', m: '\x1b[35m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' } : { g: '', y: '', r: '', c: '', m: '', d: '', b: '', x: '' };
const say = (t = '') => console.log(t);
const ok = (t) => say(`  ${C.g}✓${C.x} ${t}`);
const warn = (t) => say(`  ${C.y}!${C.x} ${t}`);
const bad = (t) => say(`  ${C.r}✗${C.x} ${t}`);
const head = (t) => say(`\n${C.b}${t}${C.x}`);
const shown = new Set();
const warnOnce = (key, t) => { if (!shown.has(key)) { shown.add(key); warn(t); } };

// ---------- the services this launcher started, and stopping them on every way out
const procs = new Map();
let shuttingDown = false, followTimer = null;
function killTree(pid) {
  try { if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
}
process.on('exit', () => {
  for (const e of procs.values()) killTree(e.p.pid);
  try { if (readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) rmSync(PIDFILE); } catch { /* none */ }
});
const stop = (t, fix) => { shuttingDown = true; say(`\n${C.r}${C.b}Stopped:${C.x} ${t}`); if (fix) say(`${C.b}What to do:${C.x} ${fix}`); process.exit(1); };
function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  if (followTimer) clearInterval(followTimer);
  say(`\n${C.d}Stopping…${C.x}`);
  for (const e of procs.values()) killTree(e.p.pid);
  procs.clear();
  say('Stopped. Run start-hookd.cmd to start again.');
  process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('SIGHUP', shutdown);   // SIGHUP: console window closed

// ---------- settings: CLI flags > environment > .env > defaults (a blank value counts as not set)
const argv = new Set(process.argv.slice(2));
function loadEnvFile() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) {
    if (existsSync(join(ROOT, '.env.example'))) { copyFileSync(join(ROOT, '.env.example'), p); say(`${C.d}Created .env from .env.example (your settings file; never committed to git).${C.x}`); }
    return {};
  }
  const out = {};
  for (const line of readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const file = loadEnvFile();
const setting = (k, d = '') => [process.env[k], file[k]].map((v) => (v ?? '').trim()).find(Boolean) || d;
const onOff = (k, d) => !/^(off|no|false|0)$/i.test(setting(k, d));
const modeSet = argv.has('--demo') ? 'demo' : argv.has('--live') ? 'live' : argv.has('--preview') ? 'preview' : setting('HOOKD_MODE', 'auto').toLowerCase();
if (!['auto', 'live', 'demo', 'preview'].includes(modeSet)) stop(`HOOKD_MODE in .env is "${modeSet}".`, 'Set HOOKD_MODE to auto, live, demo or preview (or leave it empty).');
let mode = modeSet;
const follow = !argv.has('--no-follow') && onOff('HOOKD_FOLLOW', 'on');
const indexerOn = !argv.has('--no-indexer') && onOff('HOOKD_INDEXER', 'on');
const browserOn = !argv.has('--no-browser') && onOff('HOOKD_OPEN_BROWSER', 'on');
const checkOnly = argv.has('--check');

// ---------- helpers
// pnpm and npm are .cmd shims on Windows, so they go through the shell as one command line (their arguments are plain words)
const run = (cmd, args, opts = {}) => (WIN && (cmd === 'pnpm' || cmd === 'npm')
  ? spawnSync([cmd, ...args].join(' '), { cwd: ROOT, encoding: 'utf8', shell: true, windowsHide: true, ...opts })
  : spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...opts }));
const git = (...args) => { const r = run('git', args); return r.status === 0 ? r.stdout.trim() : null; };
const lines = (s) => (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const verGte = (v, min) => { const a = v.split('.').map(Number), b = min.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); } return true; };
// true when free, else the listen error code (EADDRINUSE: a program has it; EACCES: Windows reserved it)
const portState = (port) => new Promise((res) => { const s = createServer().once('error', (e) => res(e.code || 'ERR')).once('listening', () => s.close(() => res(true))).listen(port, '127.0.0.1'); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ask(q) {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim().toLowerCase(); } finally { rl.close(); }
}
function commandLineOf(pid) {
  if (WIN) return run('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter ('ProcessId=' + ${Number(pid)})).CommandLine`]).stdout?.trim() ?? '';
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return run('ps', ['-p', String(pid), '-o', 'command=']).stdout?.trim() ?? ''; }
}
const isLauncher = (pid) => { try { process.kill(pid, 0); } catch { return false; } return /start\.mjs/.test(commandLineOf(pid)); };
async function rpcCall(url, method) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json(); if (j.error) throw new Error(j.error.message ?? 'RPC error'); return j.result;
}

say(`${C.b}${C.g}Hookd${C.x}${C.b} local run${C.x}  ${C.d}${ROOT}${C.x}`);

// ---------- 0. one launcher per folder: two would fight over pulls, ports and restarts
mkdirSync(LOGS, { recursive: true });
if (!checkOnly) {
  let old = 0; try { old = Number(readFileSync(PIDFILE, 'utf8').trim()); } catch { /* none */ }
  if (old && old !== process.pid && isLauncher(old)) {
    warn(`Hookd is already running in another window (PID ${old}).`);
    if ((await ask('    Stop that one and start here? [y/N] ')) !== 'y') stop('Hookd is already running in another window.', 'Use that window, or close it and run start-hookd.cmd again.');
    if (WIN) killTree(old); else { try { process.kill(old, 'SIGTERM'); } catch { /* gone */ } }   // it stops its own services
    for (let i = 0; i < 20 && isLauncher(old); i++) await sleep(500);
    ok('Stopped the other window (it may still say "Press any key"; you can close it)');
  }
  writeFileSync(PIDFILE, String(process.pid));
}

// ---------- 1. tools
head('1. Tools');
const node = process.versions.node;
const major = Number(node.split('.')[0]);
if (!((major === 20 && verGte(node, '20.19.0')) || verGte(node, '22.12.0'))) stop(`Node ${node} is too old for the site's build tool (it needs 20.19+ or 22.12+).`, 'Install the LTS version of Node from https://nodejs.org, close this window and run start-hookd.cmd again.');
ok(`Node ${node}`);
let pnpmV = run('pnpm', ['--version']);
if (pnpmV.status !== 0 && WIN && (await ask('  pnpm (the package tool) is not installed. Install it now? [y/N] ')) === 'y') {
  run('npm', ['install', '-g', 'pnpm'], { stdio: 'inherit' }); pnpmV = run('pnpm', ['--version']);
}
if (pnpmV.status !== 0) stop('pnpm is not installed.', `Open PowerShell or Command Prompt and run:  ${WIN ? 'npm.cmd' : 'npm'} install -g pnpm   then run start-hookd.cmd again.`);
ok(`pnpm ${pnpmV.stdout.trim()}`);
if (git('--version') === null) stop('git is not installed.', 'Install Git from https://git-scm.com/download/win, then run start-hookd.cmd again.');
ok('git');

// ---------- 2. what changed (the monitoring view), then pull
head('2. What changed');
let gitOk = true, branch = null, remote = null, hasRemote = false;
const inside = run('git', ['rev-parse', '--is-inside-work-tree']);
if (inside.status !== 0) {
  if (/dubious ownership/.test(inside.stderr ?? '')) stop('Git does not trust this folder yet.', `Run the command git printed:\n${inside.stderr.trim()}`);
  gitOk = false; warn('This folder was not downloaded with git (for example "Download ZIP"), so it cannot follow new work. To follow it: git clone https://github.com/Trench-launches/Hookd.git and run start-hookd.cmd in the new folder.');
}
/** Pull `remote` into the checked-out branch without ever losing local work. unpublishedBefore = commits on this PC
 *  that no GitHub branch had before the fetch (0 means every local commit came from GitHub). */
function pull(unpublishedBefore) {
  if (git('merge', '--ff-only', '--quiet', remote) !== null) return { pulled: true };
  const edits = lines(git('diff', '--name-only', 'HEAD'));
  const ahead = Number(git('rev-list', '--count', `${remote}..HEAD`) ?? 0);
  if (ahead > 0 && unpublishedBefore === 0 && !edits.length) {
    // the developer rewrote the branch on GitHub (force-push) and this PC has nothing of its own: keep a backup, take GitHub's
    const backup = `hookd-backup-${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}`;
    if (git('branch', '-f', backup, 'HEAD') !== null && git('reset', '--hard', '--quiet', remote) !== null) return { pulled: true, rewritten: backup };
  }
  return { pulled: false, edits };
}
const blockedMsg = (r) => `GitHub has new work, but ${r.edits?.length ? `files edited on this PC are in the way (${r.edits.slice(0, 3).join(', ')}${r.edits.length > 3 ? ', …' : ''})` : 'this PC has commits of its own'}, so nothing was pulled or overwritten. Run: git status`;
if (gitOk) {
  branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (!branch) stop('This folder is not on a branch.', 'In PowerShell, in this folder:  git checkout main   then run start-hookd.cmd again.');
  remote = `origin/${branch}`;
  const unpublished = Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes') ?? 1);
  if (git('fetch', '--quiet', '--prune', 'origin') === null) warn('Could not reach GitHub; showing what this PC already has.');
  hasRemote = git('rev-parse', '--verify', '--quiet', remote) !== null;
  if (hasRemote) {
    const behind = Number(git('rev-list', '--count', `HEAD..${remote}`) ?? 0), ahead = Number(git('rev-list', '--count', `${remote}..HEAD`) ?? 0);
    say(`  On ${C.c}${branch}${C.x}: ${behind ? `${C.y}${behind} new commit(s) on GitHub${C.x}` : 'up to date with GitHub'}${ahead ? `, ${ahead} commit(s) not on GitHub` : ''}`);
    if (behind && follow && !checkOnly) {
      const r = pull(unpublished);
      if (r.rewritten) ok(`The developer rewrote ${branch} on GitHub; updated to it (your old copy is saved as branch ${r.rewritten}).`);
      else if (r.pulled) ok(`Pulled ${behind} commit(s).`);
      else warn(blockedMsg(r));
    }
  } else warn(`${branch} is not on GitHub (it may have been merged). To follow the main site:  git checkout main   then run start-hookd.cmd again.`);
  say(`  ${C.d}Latest on ${branch}:${C.x}`);
  for (const l of lines(git('log', '-6', '--date=format:%d %b %H:%M', '--format=%ad  %s'))) say(`    ${C.d}${l.slice(0, 13)}${C.x}${l.slice(13, 110)}`);
  // other GitHub branches with work that is not on this branch yet, newest first, so nothing in flight is invisible
  const others = lines(git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin'))
    .filter((r) => r !== 'origin/HEAD' && r !== 'origin' && r !== remote)
    .map((r) => ({ r, n: Number(git('rev-list', '--count', `HEAD..${r}`) ?? 0) })).filter((o) => o.n > 0);
  if (others.length) {
    say(`  ${C.d}On GitHub but not on ${branch} yet:${C.x}`);
    for (const o of others.slice(0, 6)) say(`    ${C.m}${o.r.replace('origin/', '')}${C.x} +${o.n}  ${C.d}${(git('log', '-1', '--format=%s  (%cr)', o.r) ?? '').slice(0, 90)}${C.x}`);
    if (others.length > 6) say(`    ${C.d}…and ${others.length - 6} more (git branch -r)${C.x}`);
  }
}

// ---------- 3. packages (the site imports shared code from sdk/ and app/, whose packages live at the root: both always)
head('3. Packages');
function needsInstall(dir) {
  const marker = join(dir, 'node_modules', '.modules.yaml'), lock = join(dir, 'pnpm-lock.yaml');
  return !existsSync(marker) || (existsSync(lock) && statSync(lock).mtimeMs > statSync(marker).mtimeMs);
}
/** Install from the lockfile only (never rewrites the tracked lockfile). Returns null when fine, else the reason. */
function install(dir, label) {
  if (!needsInstall(dir)) { ok(`${label} packages up to date`); return null; }
  say(`  Installing ${label} packages (the first time takes a few minutes)…`);
  if (run('pnpm', ['install', '--frozen-lockfile'], { cwd: dir, stdio: 'inherit' }).status === 0) { ok(`${label} packages installed`); return null; }
  const again = run('pnpm', ['install', '--frozen-lockfile'], { cwd: dir });   // once more, for a network blip; captured to read the cause
  if (again.status === 0) { ok(`${label} packages installed`); return null; }
  const out = `${again.stdout ?? ''}${again.stderr ?? ''}`;
  for (const l of lines(out).slice(-6)) say(`    ${C.d}${l}${C.x}`);
  return /ERR_PNPM_OUTDATED_LOCKFILE|lockfile.*not up to date/i.test(out)
    ? 'The package list on GitHub is out of date (the developer has to update pnpm-lock.yaml).'
    : 'Installing packages failed. Check your internet connection.';
}
if (!checkOnly) for (const [dir, label] of [[ROOT, 'shared'], [WEB, 'site']]) { const why = install(dir, label); if (why) stop(why, 'Tell the developer, or try again in a minute: run start-hookd.cmd again.'); }

// ---------- 4. live checks (read-only)
head('4. Devnet checks');
const report = { keys: false, keyProblem: '', records: 0, mints: 0, rpc: null, rpcOk: false, rpcProblem: '', studio: [] };
let kd = null;
if (mode !== 'demo') {
  kd = (() => {
    const v = setting('DEVNET_KEY_DIR');
    if (!v) return join(ROOT, '.devnet-keys');
    if (!isAbsolute(v)) stop(`DEVNET_KEY_DIR in .env is "${v}", which is not a full path.`, 'Use a full path such as C:\\hookd-keys (no ~), or leave it empty to use the .devnet-keys folder in the repo.');
    const rel = relative(ROOT, resolve(v));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) stop('DEVNET_KEY_DIR in .env points inside the repo folder.', 'Leave it empty to use .devnet-keys in the repo, or point it at a folder outside it.');
    return v;
  })();
  let web3 = null;
  try { web3 = createRequire(join(ROOT, 'package.json'))('@solana/web3.js'); } catch { /* checked below without it */ }
  /** A key file is a JSON list of 64 numbers (0-255). Returns { pk } or { err } in plain words. */
  const readKey = (p) => {
    const buf = readFileSync(p);
    if ((buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) || (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return { err: 'was re-saved by a text editor in a different format; put the developer\'s original file back' };
    let a; try { a = JSON.parse(buf.toString('utf8')); } catch { return { err: 'is not in the expected format (a list of 64 numbers)' }; }
    if (!Array.isArray(a) || a.length !== 64 || !a.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return { err: 'is not in the expected format (a list of 64 numbers)' };
    try { return { pk: web3 ? web3.Keypair.fromSecretKey(Uint8Array.from(a)).publicKey.toBase58() : null }; } catch { return { err: 'is not a valid key' }; }
  };
  const expected = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'keeper', 'devnet.tdt.json'), 'utf8')); } catch { return {}; } })();
  const deployer = join(kd, 'deployer.json'), launch = join(kd, 'launch.json');
  if (!existsSync(deployer)) { report.keyProblem = `The devnet admin key (deployer.json) is not in ${kd}.`; bad(`${report.keyProblem} The backend cannot start without it.`); }
  else {
    const d = readKey(deployer), l = existsSync(launch) ? readKey(launch) : null;
    if (d.err) { report.keyProblem = `deployer.json ${d.err}.`; bad(report.keyProblem); }
    else if (l?.err) { report.keyProblem = `launch.json ${l.err}.`; bad(`${report.keyProblem} The backend cannot start with it.`); }
    else {
      report.keys = true;
      if (d.pk && expected.hook_upgrade_authority && d.pk !== expected.hook_upgrade_authority) warn(`deployer.json is ${d.pk.slice(0, 8)}…, but the live program's admin is ${expected.hook_upgrade_authority.slice(0, 8)}…: an older key. Pages load; admin actions and studio launches are refused.`);
      else ok(`Admin key found${d.pk ? ` (${d.pk.slice(0, 8)}…)` : ''}`);
      if (!l) warn('launch.json is missing: the backend will make a new one, and studio launches will be refused until the developer\'s launch.json replaces it.');
      else if (l.pk && expected.hook_launch_authority && l.pk !== expected.hook_launch_authority) warn(`launch.json is ${l.pk.slice(0, 8)}…, not the program's launch key ${expected.hook_launch_authority.slice(0, 8)}…: studio launches will be refused.`);
      else ok('Launch key found');
    }
  }
  // OneDrive uploads whatever is in a synced folder, gitignored or not
  if (WIN) {
    const inOneDrive = (p) => [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean).some((od) => { const r = win32.relative(od, p); return !r.startsWith('..') && !win32.isAbsolute(r); });
    if (existsSync(deployer) && inOneDrive(kd)) warn(`The keys folder is synced by OneDrive, so deployer.json and launch.json are uploaded to your OneDrive. Safer: move them to a folder outside OneDrive (for example C:\\hookd-keys) and set DEVNET_KEY_DIR=C:\\hookd-keys in .env.`);
  }
  // the token list = registry mints that also have a launch record on this PC
  let mints = [];
  try { mints = JSON.parse(readFileSync(join(ROOT, 'keeper', 'registry.json'), 'utf8')).devnet ?? []; } catch { /* none */ }
  const recDir = join(ROOT, 'launches', 'devnet');
  const have = new Set(existsSync(recDir) ? readdirSync(recDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []);
  report.mints = mints.length; report.records = mints.filter((m) => have.has(m)).length;
  if (!mints.length) warn('No tokens are listed in keeper/registry.json.');
  else if (report.records === mints.length) ok(`All ${mints.length} listed tokens have their launch records`);
  else if (report.records === 0) bad(`None of the ${mints.length} listed tokens have launch records on this PC (${recDir}). The token list will be empty.`);
  else warn(`${report.records} of ${mints.length} listed tokens have launch records here; missing ${mints.filter((m) => !have.has(m)).map((m) => m.slice(0, 4)).join(', ')} (those won't show)`);
  // RPC: DEVNET_RPC, else the Helius key file the test day used, else the rate-limited public default
  let rpc = setting('DEVNET_RPC');
  if (rpc && !/^https?:\/\/\S+$/i.test(rpc)) stop('DEVNET_RPC in .env is not a full URL.', 'It must start with https:// (for example https://devnet.helius-rpc.com/?api-key=YOUR_KEY).');
  if (!rpc) {
    const f = [join(kd, 'helius_rpc.txt'), join(ROOT, '.devnet-keys', 'helius_rpc.txt')].find(existsSync);
    if (f) {
      const t = readFileSync(f, 'utf8').trim();
      rpc = /^https?:\/\/\S+$/.test(t) ? t : /^[A-Za-z0-9-]{20,}$/.test(t) ? `https://devnet.helius-rpc.com/?api-key=${t}` : '';
      if (rpc) ok('Using the Helius devnet RPC from helius_rpc.txt');
    }
  }
  if (rpc && /mainnet/i.test(rpc)) stop('DEVNET_RPC points at mainnet.', 'Use a devnet RPC URL. This project never touches mainnet.');
  if (!rpc) warn('No private RPC set: using the public devnet RPC, which rate-limits token pages. Put a free Helius devnet URL in .env as DEVNET_RPC.');
  report.rpc = rpc || null;
  const target = rpc || 'https://solana-devnet.api.onfinality.io/public';
  try {
    const g = await rpcCall(target, 'getGenesisHash');
    if (g !== DEVNET_GENESIS) stop('The RPC in DEVNET_RPC is not a Solana devnet RPC.', 'Set DEVNET_RPC in .env to a devnet URL (for example https://devnet.helius-rpc.com/?api-key=YOUR_KEY).');
    report.rpcOk = true; ok(`Devnet RPC answers (${new URL(target).host})`);
  } catch (e) {
    const m = String(e.message ?? e);
    report.rpcProblem = /HTTP 40[13]/.test(m) ? (rpc ? 'it refused the request (check the key in DEVNET_RPC)' : 'the public devnet RPC refused the request (set DEVNET_RPC)') : /HTTP 429/.test(m) ? 'it is rate-limiting this PC' : /timeout|aborted/i.test(m) ? 'it did not answer within 10 s' : /HTTP/.test(m) ? `it returned an error (${m})` : 'it could not be reached (check the URL and your internet)';
    bad(`The devnet RPC check failed: ${report.rpcProblem}.`);
  }
  report.studio = setting('STUDIO_WALLETS').split(',').map((s) => s.trim()).filter(Boolean);
  // checked after the mode is chosen (only matters for live data), but validated with web3 here
  report.badWallets = web3 ? report.studio.filter((w) => { try { return new web3.PublicKey(w).toBase58() !== w; } catch { return true; } }) : [];
} else say(`  ${C.d}Skipped (sample data)${C.x}`);

// ---------- 5. choose the mode
const live = () => mode === 'live' || mode === 'preview';
if (mode === 'auto') mode = report.keys && report.rpcOk ? 'live' : 'demo';
if (live() && !report.keys) stop(report.keyProblem || 'Live data needs the devnet admin key on this PC.', `Ask the developer for deployer.json and launch.json (sent privately, never by email or chat), put them in ${kd}, then run again. Or run start-hookd.cmd --demo for sample tokens.`);
if (live() && !report.rpcOk) stop(`The backend needs a working devnet RPC to start: ${report.rpcProblem}.`, 'Put a devnet RPC URL in .env as DEVNET_RPC (a free Helius devnet key works: https://devnet.helius-rpc.com/?api-key=YOUR_KEY), then run again.');
if (live() && report.badWallets?.length) stop(`STUDIO_WALLETS in .env has an address that is not a valid Solana address: ${report.badWallets.map((w) => JSON.stringify(w)).join(', ')}`, 'Copy the address again from your wallet (comma-separated if more than one), or leave STUDIO_WALLETS empty.');
head(`5. Mode: ${mode === 'demo' ? `${C.y}SAMPLE DATA${C.x}${C.b} (not real tokens)` : mode === 'live' ? `${C.g}LIVE devnet data${C.x}` : `${C.g}PREVIEW${C.x}${C.b} (built site on ${API_PORT})`}`);
if (mode === 'demo' && modeSet === 'auto') say(`  ${C.d}Live data needs the admin key and a working devnet RPC; see step 4.${C.x}`);
if (live()) say(report.studio.length ? `  Studio open for ${report.studio.length} wallet(s): launches from it are real devnet transactions, paid by the admin key` : `  ${C.d}Studio closed (set STUDIO_WALLETS in .env to sign in and launch)${C.x}`);
if (checkOnly) { say(`\n${C.d}--check: nothing was started.${C.x}`); process.exit(0); }

// ---------- 6. ports
head('6. Ports');
async function freePort(port, what) {
  const st = await portState(port);
  if (st === true) { ok(`${port} free (${what})`); return; }
  if (st !== 'EADDRINUSE') stop(`Windows will not let any program use port ${port} (${st}). This is usually a range reserved by Hyper-V, WSL or Docker.`, `Restart the PC and try again. To check: netsh int ipv4 show excludedportrange protocol=tcp. Fix: in PowerShell as Administrator run  net stop winnat  then  net start winnat`);
  let pid = '', name = '', parent = '', parentCmd = '';
  if (WIN) {
    const ps = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess); $q = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId); @($c.OwningProcess, $p.Name, $p.ParentProcessId, $q.CommandLine) -join '|' }`;
    [pid = '', name = '', parent = '', parentCmd = ''] = (run('powershell', ['-NoProfile', '-Command', ps]).stdout ?? '').trim().split('|');
  }
  const ofLauncher = parent && /start\.mjs/.test(parentCmd);
  warn(`Port ${port} (${what}) is already in use${pid ? ` by ${ofLauncher ? 'another Hookd window' : name || 'a program'} (PID ${ofLauncher ? parent : pid})` : ''}.`);
  if (pid && (await ask(`    Stop it? [y/N] `)) === 'y') {
    killTree(ofLauncher ? parent : pid);   // a Hookd window is stopped whole, with everything it started
    for (let i = 0; i < 10 && (await portState(port)) !== true; i++) await sleep(500);
    if ((await portState(port)) === true) { ok(`${port} freed`); return; }
  }
  stop(`Port ${port} is busy.`, 'Close the other window that is running the site (often an older Hookd window), then run start-hookd.cmd again.');
}
if (mode !== 'demo') await freePort(API_PORT, 'backend');
if (mode !== 'preview') await freePort(SITE_PORT, 'site');

// ---------- 7. start
head('7. Starting');
const childEnv = { ...process.env, ...Object.fromEntries(['DEVNET_RPC', 'DEVNET_KEY_DIR', 'STUDIO_WALLETS'].map((k) => [k, setting(k)]).filter(([, v]) => v)) };
if (report.rpc) childEnv.DEVNET_RPC = report.rpc;
delete childEnv.PORT;   // the site's proxy expects the backend on 5175
const COLORS = { api: C.c, site: C.m, charts: C.y };
// most specific first; matched against the service's last lines once its output has fully drained
const HINTS = [
  [/EADDRINUSE/, 'A port is already in use: close the other Hookd window.'],
  [/devnet \w+ key is not in/, 'The devnet admin key is missing (step 4).'],
  [/DEVNET_KEY_DIR must be/, 'DEVNET_KEY_DIR in .env must be a full path outside the repo.'],
  [/RPC is mainnet/, 'DEVNET_RPC points at mainnet.'],
  [/STUDIO_WALLETS: "/, 'STUDIO_WALLETS in .env has a bad address.'],
  [/web\/dist is missing/, 'The site was not built (preview mode builds it first).'],
  [/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|\b429\b|\b403\b|Too Many Requests|getGenesisHash/, 'The devnet RPC is unreachable or rate-limited: set DEVNET_RPC in .env to a private devnet URL.'],
];
const pageServer = () => (mode === 'preview' ? 'api' : 'site');
function start(name, args, cwd = ROOT) {
  const log = createWriteStream(join(LOGS, `${name}.log`), { flags: 'a' });
  let logOk = true;
  log.on('error', (e) => { if (logOk) { logOk = false; warn(`Could not write logs\\${name}.log (${e.code}); showing output here only.`); } });
  log.write(`\n--- ${new Date().toISOString()} ${args.join(' ')}\n`);
  const p = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !WIN });
  const tail = [], seen = new Set();   // the indexer repeats the same status lines every loop: show each once (all go to the log)
  const pipe = (s) => {
    let buf = ''; s.setEncoding('utf8');
    s.on('data', (d) => {
      if (logOk) log.write(d);
      buf += d; const ls = buf.split(/\r?\n/); buf = ls.pop();
      for (const l of ls) {
        if (!l.trim() || /bigint: Failed to load bindings/.test(l)) continue;
        tail.push(l); if (tail.length > 40) tail.shift();
        if (name === 'charts') { if (seen.has(l)) continue; if (seen.size > 500) seen.clear(); seen.add(l); }
        say(`${COLORS[name] ?? ''}${name.padEnd(6)}${C.x}│ ${l}`);
      }
    });
  };
  pipe(p.stdout); pipe(p.stderr);
  const entry = { p, stopping: false };
  p.on('exit', () => { if (procs.get(name) === entry) procs.delete(name); });
  p.on('close', (code) => {   // after stdout/stderr have drained, so the hint sees the last lines
    log.end();
    if (entry.stopping || shuttingDown) return;
    const hint = HINTS.find(([re]) => tail.some((l) => re.test(l)));
    say(`\n${C.r}${name} stopped (code ${code}).${C.x} ${hint ? `${C.b}${hint[1]}${C.x}` : `See logs\\${name}.log.`}`);
    if (name === pageServer() && running) { if (followTimer) clearInterval(followTimer); stop(`The ${name === 'api' ? 'backend' : 'site'} stopped, so the page is down.`, 'Fix what the red line above says, then run start-hookd.cmd again.'); }
    if (name === 'api' && running) warn('Live data is unavailable until the backend runs again: press Ctrl+C and run start-hookd.cmd again.');
  });
  procs.set(name, entry);
  return entry;
}
/** Stop one service and wait (up to 5 s) until it has really exited. */
function kill(name) {
  const e = procs.get(name); if (!e) return Promise.resolve();
  e.stopping = true;
  if (e.p.exitCode !== null || e.p.signalCode !== null) { procs.delete(name); return Promise.resolve(); }
  return new Promise((res) => { const t = setTimeout(res, 5000); e.p.once('exit', () => { clearTimeout(t); res(); }); killTree(e.p.pid); });
}
async function portFreed(port) { for (let i = 0; i < 20 && (await portState(port)) !== true; i++) await sleep(250); }
const tsx = ['--import', 'tsx'];
const vite = join(WEB, 'node_modules', 'vite', 'bin', 'vite.js');
const startApi = () => start('api', [...tsx, 'app/server.ts', '--cluster', 'devnet', ...(mode === 'preview' ? ['--web'] : [])]);
const startSite = () => start('site', [vite, ...(mode === 'demo' ? ['--mode', 'fixtures'] : [])], WEB);
const startCharts = () => start('charts', [...tsx, 'scripts/indexer.ts', 'loop', '--cluster', 'devnet', '--every', '30']);
async function waitFor(url, name, secs) {
  for (let i = 0; i < secs * 2; i++) {
    if (!procs.has(name)) return false;
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}
const build = () => run('pnpm', ['build'], { cwd: WEB, stdio: 'inherit' }).status === 0;
let running = false;
if (mode === 'preview') { say('  Building the site…'); if (!build()) stop('Building the site failed (see above).', 'Send the developer a screenshot of this window.'); }
if (mode !== 'demo') {
  startApi();
  if (!(await waitFor(`http://127.0.0.1:${API_PORT}/api/meta`, 'api', 90))) stop('The backend did not start (see the red lines above).', 'Fix what the line above says, then run start-hookd.cmd again.');
  ok(`Backend up on ${API_PORT}`);
}
if (mode !== 'preview') {
  startSite();
  if (!(await waitFor(`http://127.0.0.1:${SITE_PORT}/`, 'site', 60))) stop('The site did not start (see above).', 'Send the developer a screenshot of this window.');
  ok(`Site up on ${SITE_PORT}`);
}
if (mode !== 'demo' && indexerOn) startCharts();
running = true;

const url = `http://127.0.0.1:${mode === 'preview' ? API_PORT : SITE_PORT}`;
let listed = '';
if (mode !== 'demo') { try { listed = `${(await (await fetch(`http://127.0.0.1:${API_PORT}/api/meta`)).json()).launches?.length ?? 0} token(s) listed`; } catch { /* left blank */ } }
const followingNow = follow && gitOk && hasRemote;
head('Hookd is running');
say(`  Open        ${C.b}${url}${C.x}`);
say(`  Data        ${mode === 'demo' ? `${C.y}SAMPLE tokens (not real)${C.x}` : `live devnet${listed ? `, ${listed}` : ''}`}`);
if (gitOk) say(`  Branch      ${branch} @ ${git('log', '-1', '--format=%h %s') ?? ''}`.slice(0, 120));
if (mode !== 'demo') say(`  RPC         ${report.rpc ? new URL(report.rpc).host : 'public devnet (rate-limited)'}   Studio ${report.studio.length ? 'open' : 'closed'}`);
say(`  Following   ${followingNow ? `on: checks GitHub every ${FOLLOW_EVERY_S}s, ${mode === 'preview' ? 'rebuilds; refresh the page after a pull' : 'the page reloads by itself'}` : 'off'}`);
say(`  Logs        logs\\api.log, logs\\site.log, logs\\charts.log, logs\\changes.log`);
say(`  Stop        Ctrl+C in this window`);
if (browserOn) {
  if (WIN) spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  else if (run('which', ['xdg-open']).status === 0) spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

// ---------- 8. follow the branch: pull, then reinstall/restart only what the pulled files need
let following = false, fetchFails = 0;
async function followOnce() {
  if (following || shuttingDown) return; following = true;
  try {
    const cur = git('symbolic-ref', '--quiet', '--short', 'HEAD');
    if (cur !== branch) { warnOnce(`switched:${cur}`, `This folder is now on ${cur ?? 'no branch'}, so following ${branch} is paused. Press Ctrl+C and run start-hookd.cmd again to follow ${cur ?? 'a branch'}.`); return; }
    const unpublished = Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes') ?? 1);
    if (git('fetch', '--quiet', '--prune', 'origin') === null) { if (++fetchFails === 3) warn('Cannot reach GitHub right now; still trying every 30 s.'); return; }
    if (fetchFails >= 3) ok('GitHub reachable again.');
    fetchFails = 0;
    if (git('rev-parse', '--verify', '--quiet', remote) === null) {
      warn(`${branch} is no longer on GitHub (probably merged). Following stopped. To follow the main site: press Ctrl+C, run  git checkout main  and start-hookd.cmd again.`);
      clearInterval(followTimer); followTimer = null; return;
    }
    if (!Number(git('rev-list', '--count', `HEAD..${remote}`) ?? 0)) return;
    const before = git('rev-parse', 'HEAD');
    const r = pull(unpublished);
    if (!r.pulled) { warnOnce(`blocked:${git('rev-parse', remote)}`, blockedMsg(r)); return; }
    const commits = lines(git('log', '--format=%h %s', `${before}..HEAD`));
    const files = lines(git('diff', '--name-only', before, 'HEAD'));
    say(`\n${C.g}${C.b}${r.rewritten ? `The developer rewrote ${branch}; updated (old copy saved as ${r.rewritten}).` : `Pulled ${commits.length} new commit(s):`}${C.x}`);
    for (const c of commits.slice(0, 12)) say(`  ${C.g}${c.slice(0, 110)}${C.x}`);
    try { appendFileSync(join(LOGS, 'changes.log'), `${new Date().toISOString()}\n${commits.map((c) => `  ${c}`).join('\n')}\n`); } catch { /* the console has it */ }
    const touched = (re) => files.some((f) => re.test(f));
    const rootDeps = touched(/^(package\.json|pnpm-lock\.yaml)$/), webDeps = touched(/^web\/(package\.json|pnpm-lock\.yaml)$/);
    for (const [need, dir, label] of [[rootDeps, ROOT, 'shared'], [webDeps, WEB, 'site']]) {
      const why = need ? install(dir, label) : null;
      if (why) { warn(`${why} Still running the previous packages.`); return; }
    }
    if (touched(/^(scripts\/start\.mjs|start-hookd\.cmd|\.env\.example)$/)) warn('The launcher itself was updated: press Ctrl+C and run start-hookd.cmd again to use the new version.');
    if (mode !== 'demo' && (rootDeps || touched(/^(app|sdk)\//))) {
      if (report.studio.length) warn('Backend code changed. The studio is open, so the backend is not restarted automatically (a restart during a launch could lose it). When no launch is running: press Ctrl+C and run start-hookd.cmd again.');
      else {
        say(`${C.c}Backend code changed: restarting the backend…${C.x}`);
        await kill('api'); await portFreed(API_PORT);
        if (mode === 'preview' && !build()) warn('Rebuilding the site failed (see above); serving the previous version.');
        startApi();
        if (await waitFor(`http://127.0.0.1:${API_PORT}/api/meta`, 'api', 90)) ok('Backend restarted');
      }
    } else if (mode === 'preview' && touched(/^web\//)) {
      say(`${C.c}Site changed: rebuilding…${C.x}`);
      if (build()) ok('Rebuilt: refresh the page'); else warn('Rebuilding the site failed (see above); serving the previous version.');
    }
    if (mode !== 'preview' && webDeps) { await kill('site'); await portFreed(SITE_PORT); startSite(); }
    if (procs.has('charts') && (rootDeps || touched(/^(sdk\/|scripts\/indexer\.ts$)/))) { await kill('charts'); startCharts(); }
  } finally { following = false; }
}
if (followingNow) followTimer = setInterval(() => { followOnce().catch((e) => warn(`Following hit an error: ${e.message}`)); }, FOLLOW_EVERY_S * 1000);
