import { describe, expect, it } from 'vitest';
import { pbkdf2Sync } from 'node:crypto';
import { deriveKey, fromBase64, KDF_ITERATIONS, loginSecret, newSalt, seal, toBase64, unseal, validKdf, WrongPassphrase } from '../src/data/crypto.ts';
import { emptyDataset } from '../src/data/json.ts';
import type { Dataset } from '../src/data/json.ts';
import { decideSync } from '../src/app/syncPlan.ts';

// Few iterations keep the tests fast; the app uses KDF_ITERATIONS.
const ITER = 1000;

function sample(n: number): Dataset {
  const d = emptyDataset();
  d.accounts.push({ id: 'broker', name: 'Broker demo', ccy: 'USD' });
  d.ledger.push({ id: 't1', date: '2025-01-02', type: 'BUY', account: 'broker', asset: 'AAA', qty: '10', amount: '1000.10', ccy: 'USD' } as Dataset['ledger'][number]);
  for (let i = 0; i < n; i++) d.prices.push({ symbol: `S${i % 50}`, date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`, close: (100 + i / 7).toFixed(4), ccy: 'USD', source: 'synthetic' });
  return d;
}

describe('crypto', () => {
  it('seals and opens the dataset exactly, amounts as strings', async () => {
    const salt = newSalt();
    const key = await deriveKey('correct horse battery staple', salt, ITER);
    const d = sample(10);
    const back = await unseal<Dataset>(await seal(d, key), key);
    expect(back).toEqual(d);
    expect(back.ledger[0]!.amount).toBe('1000.10');
  });

  it('the same passphrase and salt give a key that opens it on another device', async () => {
    const salt = newSalt();
    const blob = await seal(sample(3), await deriveKey('frase de prueba larga', salt, ITER));
    const other = await deriveKey('frase de prueba larga', salt, ITER);
    expect((await unseal<Dataset>(blob, other)).prices).toHaveLength(3);
  });

  it('the login secret is the same on every device, per email, and never the password', async () => {
    const a = await loginSecret('mi contraseña larga', 'Yo@Ejemplo.com ', ITER);
    expect(await loginSecret('mi contraseña larga', 'yo@ejemplo.com', ITER)).toBe(a);
    expect(await loginSecret('mi contraseña larga', 'otro@ejemplo.com', ITER)).not.toBe(a);
    expect(await loginSecret('otra contraseña', 'yo@ejemplo.com', ITER)).not.toBe(a);
    expect(a).toHaveLength(44);
    expect(a).not.toContain('contraseña');
  });

  it('the login secret is exactly PBKDF2-SHA-256 of the password with the per-email salt, 600000 rounds (accounts depend on it)', async () => {
    const expected = pbkdf2Sync('mi contraseña larga'.normalize('NFC'), 'investment-tracker/login/yo@ejemplo.com', 600_000, 32, 'sha256').toString('base64');
    expect(await loginSecret('mi contraseña larga', 'yo@ejemplo.com')).toBe(expected);
  });

  it('a cloud copy is opened only with the parameters the app writes, never with the login salt', () => {
    expect(validKdf(newSalt(), KDF_ITERATIONS)).toBe(true);
    expect(validKdf(newSalt(), KDF_ITERATIONS - 1)).toBe(false);
    expect(validKdf(newSalt(), 1.5e6 + 0.5)).toBe(false);
    expect(validKdf(newSalt(), 1e9)).toBe(false);
    expect(validKdf(toBase64(new TextEncoder().encode('investment-tracker/login/yo@ejemplo.com')), KDF_ITERATIONS)).toBe(false);
    expect(validKdf(toBase64(new Uint8Array(15)), KDF_ITERATIONS)).toBe(false);
    expect(validKdf('no es base64 %%', KDF_ITERATIONS)).toBe(false);
  });

  it('a wrong passphrase fails with WrongPassphrase and returns nothing', async () => {
    const salt = newSalt();
    const blob = await seal(sample(3), await deriveKey('la buena', salt, ITER));
    await expect(unseal(blob, await deriveKey('la mala', salt, ITER))).rejects.toBeInstanceOf(WrongPassphrase);
  });

  it('uses a fresh IV every time and never stores the plaintext', async () => {
    const key = await deriveKey('frase', newSalt(), ITER);
    const d = sample(5);
    const a = await seal(d, key);
    const b = await seal(d, key);
    expect(a).not.toBe(b);
    expect(fromBase64(a).subarray(0, 12)).not.toEqual(fromBase64(b).subarray(0, 12));
    expect(atob(a)).not.toContain('Broker demo');
  });

  it('compresses a large price history well below its JSON size', async () => {
    const key = await deriveKey('frase', newSalt(), ITER);
    const d = sample(50_000);
    const json = JSON.stringify(d).length;
    const blob = await seal(d, key);
    expect(blob.length).toBeLessThan(json / 3);
    expect((await unseal<Dataset>(blob, key)).prices).toHaveLength(50_000);
  });
});

describe('decideSync', () => {
  it('no cloud copy yet: upload', () => {
    expect(decideSync({ baseVersion: 0, dirty: false }, 0)).toBe('first-push');
    expect(decideSync({ baseVersion: 0, dirty: true }, 0)).toBe('first-push');
  });
  it('the cloud went back (deleted, recreated or older than seen here): conflict, never an automatic overwrite', () => {
    expect(decideSync({ baseVersion: 7, dirty: false }, 0)).toBe('conflict');
    expect(decideSync({ baseVersion: 7, dirty: false }, 1)).toBe('conflict');
    expect(decideSync({ baseVersion: 7, dirty: true }, 5)).toBe('conflict');
  });
  it('same version: idle, or push the local changes', () => {
    expect(decideSync({ baseVersion: 4, dirty: false }, 4)).toBe('idle');
    expect(decideSync({ baseVersion: 4, dirty: true }, 4)).toBe('push');
  });
  it('the cloud moved on: pull, or conflict when this device also changed', () => {
    expect(decideSync({ baseVersion: 4, dirty: false }, 5)).toBe('pull');
    expect(decideSync({ baseVersion: 4, dirty: true }, 5)).toBe('conflict');
  });
  it('a device that never synced but has changes and finds a cloud copy: conflict, never overwrite', () => {
    expect(decideSync({ baseVersion: 0, dirty: true }, 3)).toBe('conflict');
    expect(decideSync({ baseVersion: 0, dirty: false }, 3)).toBe('pull');
  });
});
