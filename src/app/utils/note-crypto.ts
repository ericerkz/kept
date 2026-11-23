// End-to-end encryption for locked notes (issue #27).
//
// Each encrypted note has its own random AES-256-GCM data key. It encrypts
// the note's content (body, checklist, images list, file names) and each of
// its image and attachment files. The data key is stored wrapped with a key
// derived from the note's passcode (PBKDF2-SHA-256). Changing the passcode
// creates a new data key and re-encrypts everything, so someone who knew the
// old passcode can't read later changes; the key's `epoch` counts these
// rotations so the server can refuse saves made with a superseded key. The
// passcode and the keys never leave the device. server.js
// (parseEncryptedEnvelope) validates the envelope format.
//
// Encrypted files are stored as ordinary note attachments named
// ENCRYPTED_FILE_NAME, so they use the existing upload, offline queue, sync,
// access checks, quota and backups. The content refers to them as
// `kept://file/<attachment sync ID>`. The server sees only their sizes.

export const E2E_LOCK_MARKER = 'e2e:v1';
// OWASP's 2023 guidance for PBKDF2-HMAC-SHA256.
export const NOTE_KDF_ITERATIONS = 600_000;
export const ENCRYPTED_FILE_PREFIX = 'kept://file/';
export const ENCRYPTED_FILE_NAME = 'encrypted.keptenc';
export const ENCRYPTED_FILE_TYPE = 'application/octet-stream';

const CONTENT_AAD = new TextEncoder().encode('kept-note-v1');
const KEY_AAD = new TextEncoder().encode('kept-key-v1');
const FILE_AAD = new TextEncoder().encode('kept-file-v1');
const FILE_MAGIC = [0x4b, 0x45, 0x46, 0x31]; // "KEF1"
const STORED_IMAGE = /^(?:[0-9]+-[a-f0-9]{24}|import-[a-f0-9]{64})\.(png|jpe?g|gif|webp)$/i;
const FILE_REF = /kept:\/\/file\/([A-Za-z0-9._:-]{1,160})/g;

export interface EncryptedFileMeta {
  name: string;
  type: string;
  size: number;
  kind: 'image' | 'attachment';
}

export interface NoteSecretContent {
  noteBody: string;
  checkBoxes: unknown[];
  // Top images and drawings (NoteImageI); data URLs or kept://file/ refs.
  images?: unknown[];
  // Decrypted details of the note's encrypted files, by attachment sync ID.
  files?: Record<string, EncryptedFileMeta>;
}

export interface NoteKdf {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  salt: string;
}

export interface NoteKeys {
  dataKey: CryptoKey;
  kdf: NoteKdf;
  wrap: { iv: string; ct: string };
  // 1 for a new lock, +1 each time the passcode change rotates the key.
  epoch: number;
}

export interface NoteEnvelope {
  v: 1;
  alg: 'AES-GCM';
  kdf: NoteKdf;
  wrap: { iv: string; ct: string };
  epoch: number;
  iv: string;
  ct: string;
  images: string[];
  files: string[];
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(byte => binary += String.fromCharCode(byte));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomNoteSalt(): string {
  return base64Url(randomBytes(16));
}

async function derivePasscodeKey(passcode: string, kdf: NoteKdf): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(kdf.salt), iterations: kdf.iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function wrapDataKey(dataKey: CryptoKey, passcode: string, iterations: number): Promise<Pick<NoteKeys, 'kdf' | 'wrap'>> {
  const kdf: NoteKdf = { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: randomNoteSalt() };
  const passcodeKey = await derivePasscodeKey(passcode, kdf);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', dataKey));
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: KEY_AAD }, passcodeKey, raw));
  raw.fill(0);
  return { kdf, wrap: { iv: base64Url(iv), ct: base64Url(ct) } };
}

// A new random note key, wrapped with the passcode. `epoch` is 1 for a new
// lock and the previous epoch + 1 when a passcode change rotates the key.
export async function createNoteKeys(passcode: string, iterations = NOTE_KDF_ITERATIONS, epoch = 1): Promise<NoteKeys> {
  // Exported only to wrap it; it stays in memory.
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return { dataKey, epoch, ...(await wrapDataKey(dataKey, passcode, iterations)) };
}

// Throws if the passcode is wrong or the envelope was altered.
export async function unlockNoteKeys(passcode: string, value: string): Promise<NoteKeys> {
  const envelope = parseNoteEnvelope(value);
  if (!envelope) throw new Error('This note’s encrypted content is unreadable.');
  const passcodeKey = await derivePasscodeKey(passcode, envelope.kdf);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.wrap.iv), additionalData: KEY_AAD }, passcodeKey, fromBase64Url(envelope.wrap.ct));
  const dataKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { dataKey, kdf: envelope.kdf, wrap: envelope.wrap, epoch: envelope.epoch };
}

export function parseNoteEnvelope(value: unknown): NoteEnvelope | null {
  if (typeof value !== 'string' || !value) return null;
  let envelope: any;
  try { envelope = JSON.parse(value); } catch { return null; }
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'AES-GCM') return null;
  const kdf = envelope.kdf;
  if (!kdf || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !Number.isInteger(kdf.iterations) || typeof kdf.salt !== 'string') return null;
  if (typeof envelope.wrap?.iv !== 'string' || typeof envelope.wrap?.ct !== 'string') return null;
  if (typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') return null;
  const epoch = envelope.epoch === undefined ? 1 : envelope.epoch;
  if (!Number.isInteger(epoch) || epoch < 1) return null;
  return {
    ...envelope,
    epoch,
    images: Array.isArray(envelope.images) ? envelope.images : [],
    files: Array.isArray(envelope.files) ? envelope.files : []
  };
}

// Stored (unencrypted) images the body refers to, in the server's naming.
export function referencedImageFiles(noteBody: string): string[] {
  const files = new Set<string>();
  for (const match of String(noteBody || '').matchAll(/\/api\/uploads\/images\/([A-Za-z0-9._-]+)/g)) {
    if (STORED_IMAGE.test(match[1])) files.add(match[1]);
  }
  return [...files].slice(0, 500);
}

export function encryptedFileUrl(syncId: string) {
  return `${ENCRYPTED_FILE_PREFIX}${syncId}`;
}

export function encryptedFileId(url: unknown): string | null {
  const match = /^kept:\/\/file\/([A-Za-z0-9._:-]{1,160})$/.exec(String(url || ''));
  return match ? match[1] : null;
}

// Encrypted files the content uses: images in the body or images list, and
// attachments.
export function encryptedFileRefs(content: NoteSecretContent): string[] {
  const refs = new Set<string>();
  for (const match of String(content.noteBody || '').matchAll(FILE_REF)) refs.add(match[1]);
  for (const image of (content.images || []) as Array<{ dataUrl?: string }>) {
    const id = encryptedFileId(image?.dataUrl);
    if (id) refs.add(id);
  }
  for (const [id, meta] of Object.entries(content.files || {})) if (meta?.kind === 'attachment') refs.add(id);
  return [...refs];
}

export async function sealNoteContent(keys: NoteKeys, content: NoteSecretContent): Promise<string> {
  const refs = encryptedFileRefs(content);
  const used = new Set(refs);
  // Drop details of files nothing uses any more (a replaced image).
  const files = Object.fromEntries(Object.entries(content.files || {}).filter(([id]) => used.has(id)));
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify({
    noteBody: String(content.noteBody ?? ''),
    checkBoxes: Array.isArray(content.checkBoxes) ? content.checkBoxes : [],
    images: Array.isArray(content.images) ? content.images : [],
    files
  }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: CONTENT_AAD }, keys.dataKey, plaintext));
  const envelope: NoteEnvelope = {
    v: 1,
    alg: 'AES-GCM',
    kdf: keys.kdf,
    wrap: keys.wrap,
    epoch: keys.epoch || 1,
    iv: base64Url(iv),
    ct: base64Url(ciphertext),
    images: referencedImageFiles(content.noteBody),
    files: refs.slice(0, 1000)
  };
  return JSON.stringify(envelope);
}

// Throws if the key is wrong or the envelope was altered.
export async function openNoteContent(keys: Pick<NoteKeys, 'dataKey'>, value: string): Promise<NoteSecretContent> {
  const envelope = parseNoteEnvelope(value);
  if (!envelope) throw new Error('This note’s encrypted content is unreadable.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv), additionalData: CONTENT_AAD }, keys.dataKey, fromBase64Url(envelope.ct));
  const content = JSON.parse(new TextDecoder().decode(plaintext));
  return {
    noteBody: String(content?.noteBody ?? ''),
    checkBoxes: Array.isArray(content?.checkBoxes) ? content.checkBoxes : [],
    images: Array.isArray(content?.images) ? content.images : [],
    files: content?.files && typeof content.files === 'object' ? content.files : {}
  };
}

// File format: "KEF1" | 12-byte IV | AES-GCM ciphertext and tag.
export async function sealFile(dataKey: CryptoKey, file: Blob): Promise<Blob> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: FILE_AAD }, dataKey, await file.arrayBuffer());
  return new Blob([new Uint8Array(FILE_MAGIC), iv, ciphertext], { type: ENCRYPTED_FILE_TYPE });
}

// Throws if the key is wrong or the file was altered.
export async function openFile(dataKey: CryptoKey, sealed: Blob, type = ''): Promise<Blob> {
  const bytes = new Uint8Array(await sealed.arrayBuffer());
  if (bytes.length < 4 + 12 + 16 || FILE_MAGIC.some((byte, index) => bytes[index] !== byte)) throw new Error('Not an encrypted Kept file.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(4, 16), additionalData: FILE_AAD }, dataKey, bytes.slice(16));
  return new Blob([plaintext], { type });
}
