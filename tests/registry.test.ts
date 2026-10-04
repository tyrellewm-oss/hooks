// Ticket 8.5: the mint registry (keeper/registry.json) and the reusable check assertRegistryMint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.equal(loadRegistry('local').size, 0); assert.equal(REGISTRY_PATH, 'keeper/registry.json');
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
