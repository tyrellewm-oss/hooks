// Devnet key dir override (DEVNET_KEY_DIR): absolute and outside the repo only; the devnet deployer is never created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { devnetKeyDirOverride, keyDir, loadOrCreate } from '../sdk/keys.js';

test('DEVNET_KEY_DIR: unset → .devnet-keys; an absolute path outside the repo is used; relative or inside the repo refuses', () => {
  assert.equal(devnetKeyDirOverride({}), null);
  assert.equal(devnetKeyDirOverride({ DEVNET_KEY_DIR: '' }), null);
  const out = mkdtempSync(join(tmpdir(), 'keys-'));
  try {
    assert.equal(devnetKeyDirOverride({ DEVNET_KEY_DIR: out }), out);
    assert.throws(() => devnetKeyDirOverride({ DEVNET_KEY_DIR: '.devnet-keys' }), /absolute/);
    assert.throws(() => devnetKeyDirOverride({ DEVNET_KEY_DIR: resolve('.devnet-keys') }), /outside the repo/);
    assert.throws(() => devnetKeyDirOverride({ DEVNET_KEY_DIR: resolve('.') }), /outside the repo/);
    assert.equal(keyDir('local'), '.local-keys');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('loadOrCreate (devnet): the deployer key is never created (a wrong key dir fails closed); other throwaway names are', () => {
  const out = mkdtempSync(join(tmpdir(), 'keys-'));
  const saved = process.env.DEVNET_KEY_DIR; process.env.DEVNET_KEY_DIR = out;
  try {
    assert.throws(() => loadOrCreate('devnet', 'deployer'), /never created/);
    assert.deepEqual(readdirSync(out), []);
    const k = loadOrCreate('devnet', 'buyerA'); assert.deepEqual(readdirSync(out), ['buyerA.json']);
    assert.ok(loadOrCreate('devnet', 'buyerA').publicKey.equals(k.publicKey), 'an existing key is loaded, not replaced');
  } finally { if (saved === undefined) delete process.env.DEVNET_KEY_DIR; else process.env.DEVNET_KEY_DIR = saved; rmSync(out, { recursive: true, force: true }); }
});
