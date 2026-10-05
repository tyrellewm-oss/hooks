// app/static.ts: the server hosts the classic page (default) or the new UI (--web, web/dist), read-only, with no
// path escapes. The HTTP test serves the real built web/dist through an http server shaped like app/server.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { staticReply, safeFile, uiModeFromArgs, assertUiBuilt } from '../app/static.ts';

function fakeRepo() {
  const d = mkdtempSync(join(tmpdir(), 'ui-'));
  mkdirSync(join(d, 'web/dist/assets'), { recursive: true }); mkdirSync(join(d, 'app/public'), { recursive: true });
  writeFileSync(join(d, 'web/dist/index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(d, 'web/dist/assets/index-abc.js'), 'console.log(1)');
  writeFileSync(join(d, 'web/dist/assets/font.woff2'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(d, 'app/public/index.html'), '<html>classic</html>');
  writeFileSync(join(d, 'app/public/app.js'), 'export {}');
  writeFileSync(join(d, 'secret.txt'), 'nope');
  return d;
}

test('--web selects the new UI; default stays the classic page; --web refuses to start without a build', () => {
  assert.equal(uiModeFromArgs(['--cluster', 'devnet']), 'classic');
  assert.equal(uiModeFromArgs(['--cluster', 'devnet', '--web']), 'web');
  const empty = mkdtempSync(join(tmpdir(), 'ui-empty-'));
  assert.throws(() => assertUiBuilt('web', empty), /web\/dist is missing/);
  assert.doesNotThrow(() => assertUiBuilt('classic', empty));
});

test('web mode: files, client routes fall back to index.html, missing assets and /api are 404', () => {
  const d = fakeRepo();
  for (const p of ['/', '/token/So11111111111111111111111111111111111111112', '/create', '/how-it-works', '/transparency']) {
    const r = staticReply(p, 'web', d); assert.equal(r.code, 200, p); assert.match(String(r.body), /id="root"/, p); assert.match(r.type!, /text\/html/);
  }
  const js = staticReply('/assets/index-abc.js', 'web', d); assert.equal(js.code, 200); assert.match(js.type!, /javascript/);
  const font = staticReply('/assets/font.woff2', 'web', d); assert.ok(Buffer.isBuffer(font.body), 'binary stays binary'); assert.equal(font.type, 'font/woff2');
  assert.equal(staticReply('/assets/missing.js', 'web', d).code, 404, 'a missing asset is a 404, not the shell');
  assert.equal(staticReply('/api/nope', 'web', d).code, 404);
});

test('classic mode keeps the old behaviour (and now works on Windows paths)', () => {
  const d = fakeRepo();
  assert.match(String(staticReply('/', 'classic', d).body), /classic/);
  assert.match(String(staticReply('/token/abc', 'classic', d).body), /classic/);
  assert.equal(staticReply('/app.js', 'classic', d).code, 200);
  assert.equal(staticReply('/create', 'classic', d).code, 404);
});

test('no path escapes: .., encoded .., absolute, drive letters, NUL and directories are refused', () => {
  const d = fakeRepo();
  for (const p of ['/../secret.txt', '/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '//etc/passwd', '/C:/Windows/win.ini', '/%00index.html', '/%E0%A4%A']) {
    for (const mode of ['web', 'classic'] as const) {
      const r = staticReply(p, mode, d);
      assert.ok(!String(r.body).includes('nope'), `${mode} ${p} must not serve a file outside the root`);
    }
  }
  assert.equal(safeFile('web/dist', 'assets', d), null, 'a directory is not a file');
  assert.equal(safeFile('web/dist', '../../secret.txt', d), null);
});

test('HTTP: the real built web/dist is served (skips if web/ is not built)', async (t) => {
  if (!existsSync('web/dist/index.html')) { t.skip('web/dist not built (cd web && pnpm build)'); return; }
  const send = (res: http.ServerResponse, code: number, obj: any, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
  };
  const srv = http.createServer((req, res) => { const st = staticReply(new URL(req.url ?? '/', 'http://x').pathname, 'web'); send(res, st.code, st.body, st.type); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const home = await fetch(base + '/token/abc'); const html = await home.text();
    assert.equal(home.status, 200); assert.match(html, /<div id="root">/);
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]; assert.ok(asset, 'index.html references the bundle');
    const js = await fetch(base + asset); assert.equal(js.status, 200); assert.match(js.headers.get('content-type')!, /javascript/);
    assert.ok((await js.text()).length > 10_000, 'the bundle is served whole');
    const css = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1]; assert.ok(css); assert.equal((await fetch(base + css)).status, 200);
    assert.equal((await fetch(base + '/..%2Fpackage.json')).status !== 200 || !(await (await fetch(base + '/..%2Fpackage.json')).text()).includes('"name"'), true);
  } finally { srv.close(); }
});

test('server.ts: static files go through staticReply() and send(); no direct file serving left', () => {
  const src = readFileSync('app/server.ts', 'utf8');
  assert.match(src, /const st = staticReply\(url\.pathname, UI\);[^\n]*\n\s*return send\(res, st\.code, st\.body, st\.type\);/);
  assert.doesNotMatch(src, /join\('app\/public'/);
});
