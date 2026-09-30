/**
 * Client-side encryption for cloud sync: the dataset is gzipped and sealed with AES-GCM under a key derived
 * from the user's password (PBKDF2-SHA-256), so the server only ever stores ciphertext. WebCrypto only.
 */

export const KDF_ITERATIONS = 600_000;
/** Fixed for good: changing it (or the login salt) would lock every account out. */
const LOGIN_ITERATIONS = 600_000;
const SALT_BYTES = 16;

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
  return toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/**
 * Only the parameters this app writes: a 16-byte salt and KDF_ITERATIONS (up to 10× more, never enough to hang the page). A cloud copy that asks
 * for others is refused before deriving anything, so a row written by someone who knows the login secret
 * (the service sees it at every sign-in) cannot make the data key equal to it: the login salt is longer.
 */
export function validKdf(salt: string, iterations: number): boolean {
  try {
    return fromBase64(salt).length === SALT_BYTES && Number.isInteger(iterations) && iterations >= KDF_ITERATIONS && iterations <= 10 * KDF_ITERATIONS;
  } catch {
    return false;
  }
}

/** A non-extractable AES-GCM key: it can be kept in IndexedDB without the raw bytes ever being readable. */
export async function deriveKey(passphrase: string, salt: string, iterations = KDF_ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromBase64(salt), iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * What the sync service gets as the account password: PBKDF2 of the user's password with a salt of its own
 * (fixed per email, so every device computes the same). It is independent of the key that opens the data
 * (another salt), so the service never holds anything that decrypts it. 44 characters, within bcrypt's 72.
 */
export async function loginSecret(password: string, email: string, iterations = LOGIN_ITERATIONS): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const salt = new TextEncoder().encode(`investment-tracker/login/${email.trim().toLowerCase()}`);
  return toBase64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, 256)));
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
