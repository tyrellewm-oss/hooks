// sdk/metadata.ts: studio-entered token details (image, description, links), and the image/metadata routes' registry
// gate (app/site_registry.ts). Local files only (temp dir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateMetadata, saveMetadata, loadMetadata, loadImage, publicMetadata, sniffImage, MetadataRefusal, MAX_IMAGE_BYTES, SOCIAL_HOSTS } from '../sdk/metadata.ts';
import { SOCIALS } from '../web/src/lib/socials.ts';
import { siteRoute } from '../app/site_registry.ts';

const MINT = 'So11111111111111111111111111111111111111112';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2]);
const img = (b: Buffer) => ({ data: b.toString('base64') });

test('image type comes from the bytes: PNG/JPEG/WebP/GIF only, never SVG or HTML', () => {
  assert.equal(sniffImage(PNG), 'image/png'); assert.equal(sniffImage(JPG), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<html><script>x</script>')), null);
  assert.throws(() => validateMetadata({ image: img(Buffer.from('<svg onload="x"/>')) }), /PNG, JPEG, WebP or GIF only/);
  assert.throws(() => validateMetadata({ image: { data: 'not base64!' } }), /base64/);
  assert.throws(() => validateMetadata({ image: img(Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])) }), /at most 512 KB/);
});

test('links: https only, no credentials, X and Telegram on their own hosts', () => {
  const ok = validateMetadata({ website: 'https://example.org/x', x: 'https://x.com/trenches', telegram: 'https://t.me/trenches' });
  assert.deepEqual([ok.website, ok.x, ok.telegram], ['https://example.org/x', 'https://x.com/trenches', 'https://t.me/trenches']);
  assert.equal(validateMetadata({ x: 'https://twitter.com/a' }).x, 'https://twitter.com/a');
  for (const [k, v, re] of [
    ['website', 'http://example.org', /https/], ['website', 'javascript:alert(1)', /https|valid/], ['website', 'https://u:p@example.org', /user name or password/],
    ['x', 'https://evil.example/x.com', /x\.com or twitter\.com/], ['telegram', 'https://t.me.evil.example/a', /t\.me/], ['website', 'https://e.org/' + 'a'.repeat(300), /at most/],
  ] as const) assert.throws(() => validateMetadata({ [k]: v }), re as RegExp, `${k}=${v}`);
  assert.equal(validateMetadata({ website: '' }).website, null);
});

test('socials: Discord, TikTok, Instagram and YouTube on their own hosts; older records read as null', () => {
  const ok = validateMetadata({ discord: 'https://discord.gg/abc', tiktok: 'https://www.tiktok.com/@a', instagram: 'https://instagram.com/a', youtube: 'https://youtu.be/xyz' });
  assert.deepEqual([ok.discord, ok.tiktok, ok.instagram, ok.youtube], ['https://discord.gg/abc', 'https://www.tiktok.com/@a', 'https://instagram.com/a', 'https://youtu.be/xyz']);
  for (const [k, v, re] of [
    ['discord', 'https://discord.evil.example/x', /discord\.gg or discord\.com/], ['tiktok', 'https://tiktok.com.evil.example/a', /tiktok\.com/],
    ['instagram', 'http://instagram.com/a', /https/], ['youtube', 'https://evil.example/youtube.com', /youtube\.com/],
  ] as const) assert.throws(() => validateMetadata({ [k]: v }), re as RegExp, `${k}=${v}`);
  assert.equal(validateMetadata({ discord: '' }).discord, null);
  // a record saved before these fields existed
  const pub = publicMetadata({ description: 'old', website: null, x: 'https://x.com/a', telegram: null, image: null, updatedAt: '2026-01-01T00:00:00.000Z' }, MINT)!;
  assert.deepEqual([pub.x, pub.discord, pub.tiktok, pub.instagram, pub.youtube], ['https://x.com/a', null, null, null, null]);
});

test('socials: the site form checks the same hosts as the server', () => {
  const site = Object.fromEntries(SOCIALS.filter(s => s.hosts).map(s => [s.key, s.hosts]));
  assert.deepEqual(site, Object.fromEntries(Object.entries(SOCIAL_HOSTS).map(([k, v]) => [k, [...v]])));
});

test('description: length limit, control characters stripped, site forbidden words refused', () => {
  assert.equal(validateMetadata({ description: '  hi\u0000 there\u0007 ' }).description, 'hi there');
  assert.throws(() => validateMetadata({ description: 'x'.repeat(281) }), /at most 280/);
  for (const w of ['to the moon', '100x soon', 'guaranteed gains', 'a safe bet', 'price floor', 'presale live']) assert.throws(() => validateMetadata({ description: w }), MetadataRefusal, w);
  assert.doesNotThrow(() => validateMetadata({ description: 'An unaudited devnet test token. Not an investment.' }));
});

test('save / replace / remove: atomic files, image re-checked on read, public view has a URL not bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'md-'));
  const m1 = saveMetadata('devnet', MINT, validateMetadata({ description: 'one', image: img(PNG) }), dir);
  assert.equal(m1.image!.type, 'image/png'); assert.deepEqual(loadImage('devnet', MINT, dir)!.data, PNG);
  const pub = publicMetadata(m1, MINT)!;
  assert.match(pub.image!, /^\/api\/token\/So1+2\/image\?v=/); assert.ok(!JSON.stringify(pub).includes(PNG.toString('base64')), 'no image bytes in the JSON');
  // text-only edit keeps the image (image undefined)
  saveMetadata('devnet', MINT, validateMetadata({ description: 'two' }), dir);
  assert.equal(loadMetadata('devnet', MINT, dir)!.description, 'two'); assert.ok(loadImage('devnet', MINT, dir));
  // replace with a JPEG: the old PNG file is gone
  saveMetadata('devnet', MINT, validateMetadata({ description: 'three', image: img(JPG) }), dir);
  assert.deepEqual(readdirSync(join(dir, 'devnet')).sort(), [`${MINT}.jpg`, `${MINT}.json`]);
  // remove
  saveMetadata('devnet', MINT, validateMetadata({ description: 'four', image: null }), dir);
  assert.equal(loadImage('devnet', MINT, dir), null); assert.ok(!existsSync(join(dir, 'devnet', `${MINT}.jpg`)));
  assert.throws(() => saveMetadata('devnet', '../../etc/passwd', validateMetadata({}), dir), /bad mint/);
  assert.equal(loadMetadata('local', MINT, dir), null);
});

test('image and metadata routes are registry + launch-record gated; image replies carry a type', async () => {
  const B = 'Aaaa1111111111111111111111111111111111111111';
  let edits = 0;
  const deps: any = { cluster: 'devnet', load: () => new Set([MINT, B]), launches: () => [{ mint: MINT }], meta: () => ({}), token: async () => ({}), trade: async () => ({ code: 200, body: 0 }),
    image: () => ({ code: 200, body: PNG, type: 'image/png' }), metadata: (_m: string, b: any) => { edits++; return { code: 200, body: b }; } };
  assert.deepEqual(await siteRoute(`/api/token/${MINT}/image`, 'GET', async () => ({}), deps), { code: 200, body: PNG, type: 'image/png' });
  assert.equal((await siteRoute(`/api/token/${B}/image`, 'GET', async () => ({}), deps))!.code, 404);
  assert.deepEqual(await siteRoute(`/api/token/${MINT}/metadata`, 'POST', async () => ({ description: 'x' }), deps), { code: 200, body: { description: 'x' } });
  assert.equal((await siteRoute(`/api/token/${B}/metadata`, 'POST', async () => ({}), deps))!.code, 404);
  assert.equal((await siteRoute(`/api/token/${MINT}/metadata`, 'GET', async () => ({}), deps))!.code, 404, 'POST only');
  assert.equal(edits, 1);
});

test('server: image bytes go through send() with their type; nosniff on every reply; metadata validated before launch', () => {
  const src = readFileSync('app/server.ts', 'utf8');
  assert.match(src, /if \(routed\?\.type\) return send\(res, routed\.code, routed\.body, routed\.type\);/);
  assert.match(src, /'x-content-type-options': 'nosniff'/);
  // metadata is validated in parseLaunchBody (shared by both launch routes) before anything is built or sent
  const start = src.indexOf('function parseLaunchBody');
  const parse = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(parse.includes("meta = validateMetadata(b.metadata)"), "parseLaunchBody validates the metadata");
  const create = src.slice(src.indexOf("if (url.pathname === '/api/create'"));
  assert.ok(create.indexOf('parseLaunchBody(') < create.indexOf('await lp.launch('), 'validated before any launch tx');
  assert.ok(create.indexOf('saveMetadata(c.name, rec.mint, p.meta)') > create.indexOf('await lp.launch('), 'saved only after the launch');
  const wallet = src.slice(src.indexOf("if (url.pathname === '/api/studio/launch/build'"));
  assert.ok(wallet.indexOf('parseLaunchBody(') < wallet.indexOf('buildUserLaunch('), 'wallet launch: validated before the build');
  const submit = src.slice(src.indexOf("if (url.pathname === '/api/studio/launch/submit'"));
  assert.ok(submit.indexOf('saveMetadata(') > submit.indexOf('submitUserLaunch('), 'wallet launch: saved only after the launch confirms');
  assert.match(src, /if \(d\.length > MAX_BODY\) throw/);
});
