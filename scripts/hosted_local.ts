// The hosted (Vercel) site, run locally for testing: VERCEL=1, so no key file is loaded and only the hosted routes take
// a POST, and the launch key comes from HOOKD_LAUNCH_KEY exactly as on Vercel (taken here from the local key file when
// unset; never printed). Serves web/dist like the CDN does. Devnet only.
//   node --import tsx scripts/hosted_local.ts [--port 5176]
import { readFileSync } from 'node:fs';
import { keyDir } from '../sdk/keys.js';

const i = process.argv.indexOf('--port');
const port = Number(i >= 0 ? process.argv[i + 1] : 5176);
process.env.VERCEL = '1';
process.env.HOOKD_LAUNCH_KEY ??= readFileSync(`${keyDir('devnet')}/launch.json`, 'utf8');
process.argv.push('--web');   // app/server.ts: serve web/dist (the CDN's job on Vercel)
const { server } = await import('../app/server.js');
server.listen(port, '127.0.0.1', () => console.log(`hosted build (VERCEL=1) on devnet: http://127.0.0.1:${port}`));
