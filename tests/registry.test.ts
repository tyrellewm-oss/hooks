// Ticket 8.5: the mint registry (keeper/registry.json) and the reusable check assertRegistryMint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { loadRegistry, assertRegistryMint, RegistryRefusal, REGISTRY_PATH } from '../sdk/registry.js';
import { KeyRuleRefusal } from '../sdk/keyrules.js';

test('registry: lists the devnet main mints of the committed keeper configs; unknown mints refuse', () => {
  const reg = loadRegistry('devnet');
  for (const f of ['keeper/devnet.tdt.json', 'keeper/devnet.fw15.json']) {
    const m = JSON.parse(readFileSync(f, 'utf8')).main_mint;
    assert.ok(reg.has(m), `${f} main mint registered`); assert.doesNotThrow(() => assertRegistryMint(reg, m));
  }
  const pk = Keypair.generate().publicKey;
  assert.throws(() => assertRegistryMint(reg, pk), (e: any) => e instanceof RegistryRefusal && e instanceof KeyRuleRefusal && e.message === `refusing: mint ${pk.toBase58()} is not in the mint registry`);
  assert.throws(() => assertRegistryMint(reg, pk.toBase58(), 'base mint'), /refusing: base mint .* is not in the mint registry/);
  assert.equal(loadRegistry('local').size, 0); assert.ok(REGISTRY_PATH.endsWith(join('keeper', 'registry.json')));
});

test('registry: a missing file, a missing cluster list or an invalid entry refuses (fail closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reg-'));
  assert.throws(() => loadRegistry('devnet', join(dir, 'none.json')), (e: any) => e instanceof RegistryRefusal && /cannot read the mint registry/.test(e.message));
  const p = join(dir, 'r.json'); writeFileSync(p, JSON.stringify({ devnet: ['not-a-key'] }));
  assert.throws(() => loadRegistry('devnet', p), /invalid "devnet" entry: not-a-key/);
  assert.throws(() => loadRegistry('mainnet', p), /has no "mainnet" list/);
  writeFileSync(p, '{'); assert.throws(() => loadRegistry('devnet', p), /cannot read the mint registry/);
  const m = Keypair.generate().publicKey.toBase58(); writeFileSync(p, JSON.stringify({ devnet: [m] }));
  assert.deepEqual([...loadRegistry('devnet', p)], [m]);
});

test('registry: the default path is this repo\'s keeper/registry.json, whatever the working directory', () => {
  assert.ok(isAbsolute(REGISTRY_PATH)); assert.equal(REGISTRY_PATH, resolve('keeper/registry.json'));
  const cwd = process.cwd();
  try { process.chdir(tmpdir()); assert.ok(loadRegistry('devnet').size >= 1); } finally { process.chdir(cwd); }
});

test('registry: assertRegistryMint is exact string equality (no prefix, extension or case-insensitive match); non-string entries are named', () => {
  const mm = Keypair.generate().publicKey.toBase58();
  for (const reg of [new Set<string>(), new Set([mm.slice(0, -1)]), new Set([mm + '1']), new Set([mm.toLowerCase()]), new Set([mm.toUpperCase()])]) {
    if (reg.has(mm)) continue;
    assert.throws(() => assertRegistryMint(reg, mm), (e: any) => e instanceof RegistryRefusal, JSON.stringify([...reg]));
  }
  for (const m of [mm.slice(0, -1), mm + '1', mm.toLowerCase()]) if (m !== mm) assert.throws(() => assertRegistryMint(new Set([mm]), m), (e: any) => e instanceof RegistryRefusal, m);
  const p = join(mkdtempSync(join(tmpdir(), 'reg-')), 'r.json'); writeFileSync(p, JSON.stringify({ devnet: [123] }));
  assert.throws(() => loadRegistry('devnet', p), (e: any) => e instanceof RegistryRefusal && /non-string "devnet" entry: 123/.test(e.message));
});
