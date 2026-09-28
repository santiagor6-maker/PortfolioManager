/**
 * Client-side encryption for cloud sync: the dataset is gzipped and sealed with AES-GCM under a key derived
 * from the user's passphrase (PBKDF2-SHA-256), so the server only ever stores ciphertext. WebCrypto only.
 */

export const KDF_ITERATIONS = 600_000;

/** The passphrase does not open this ciphertext (AES-GCM's tag check failed). */
export class WrongPassphrase extends Error {
  constructor() {
    super('La frase no abre estos datos.');
    this.name = 'WrongPassphrase';
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function newSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

/** A non-extractable AES-GCM key: it can be kept in IndexedDB without the raw bytes ever being readable. */
export async function deriveKey(passphrase: string, salt: string, iterations = KDF_ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromBase64(salt), iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function through(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** base64(iv ‖ AES-GCM(gzip(JSON))), with a fresh 12-byte IV every time. */
export async function seal(value: unknown, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await through(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream('gzip'));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return toBase64(out);
}

export async function unseal<T>(blob: string, key: CryptoKey): Promise<T> {
  const all = fromBase64(blob);
  let packed: ArrayBuffer;
  try {
    packed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, key, all.subarray(12));
  } catch {
    throw new WrongPassphrase();
  }
  const json = new TextDecoder().decode(await through(new Uint8Array(packed), new DecompressionStream('gzip')));
  return JSON.parse(json) as T;
}
