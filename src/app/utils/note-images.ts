import uploadLimits from '../../../shared/upload-limits.json';

export const MAX_FILE_BYTES = uploadLimits.maxFileBytes;
const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PHOTO_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|heic|heif|avif)$/i;

export function isNoteImageFile(file: { type?: string; mimeType?: string; name?: string; filename?: string }) {
  return /^image\//i.test(file.type || file.mimeType || '') || PHOTO_EXTENSIONS.test(file.name || file.filename || '');
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

export function imageTypeFromHeader(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brands = [ascii(bytes, 8, 12)];
    const end = Math.min(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0), bytes.length);
    for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii(bytes, offset, offset + 4));
    if (brands.some(brand => ['avif', 'avis'].includes(brand))) return 'image/avif';
    if (brands.some(brand => ['heic','heix','hevc','hevx','heim','heis','hevm','hevs','mif1','msf1'].includes(brand))) return 'image/heic';
  }
  return undefined;
}

// Walk JPEG segments rather than searching for FF D9: EXIF thumbnails may
// contain an earlier end marker. Only bytes after the main image are removed.
export function jpegStillLength(bytes: Uint8Array): number | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return offset;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return undefined;
    offset += length;
    if (marker !== 0xda) continue;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      let next = offset + 1;
      while (bytes[next] === 0xff) next++;
      const code = bytes[next];
      if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) { offset = next + 1; continue; }
      break;
    }
  }
  return undefined;
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };
async function browserDecode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* HEIC support differs between WebViews; try the image decoder next. */ }
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

async function heicDecode(blob: Blob): Promise<Decoded> {
  const worker = new Worker(new URL('assets/photo-heic-worker.js', document.baseURI), { type: 'module' });
  try {
    const pixels = await new Promise<{ width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }>(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Photo conversion timed out. Please try the photo again.')), 60000);
      worker.onmessage = event => { clearTimeout(timer); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
      worker.onerror = () => { clearTimeout(timer); reject(new Error('Could not decode this HEIC photo.')); };
      try { const buffer = await blob.arrayBuffer(); worker.postMessage(buffer, [buffer]); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
    const bitmap = await createImageBitmap(new ImageData(pixels.data, pixels.width, pixels.height));
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } finally { worker.terminate(); }
}

async function jpegPhoto(blob: Blob, type: string) {
  let decoded: Decoded;
  try { decoded = await browserDecode(blob); }
  catch (error) { if (type !== 'image/heic') throw error; decoded = await heicDecode(blob); }
  const canvas = document.createElement('canvas');
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > 64 * 1024 * 1024) throw new Error('This photo has too many pixels to process safely.');
    // Keep converted photos comfortably within mobile canvas/memory limits.
    const scale = Math.min(1, 4096 / Math.max(decoded.width, decoded.height));
    canvas.width = Math.max(1, Math.round(decoded.width * scale)); canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo conversion is unavailable.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not convert this photo.')), 'image/jpeg', 0.92));
  } finally { decoded.close(); canvas.width = canvas.height = 1; }
}

export interface PreparedNoteImage { blob: Blob; name: string; changed: boolean }
let preparationQueue: Promise<unknown> = Promise.resolve();
export function prepareNoteImage(blob: Blob, name = 'photo', options: { keepJpegBytes?: boolean } = {}): Promise<PreparedNoteImage> {
  const work = preparationQueue.then(async () => {
    if (blob.size > MAX_FILE_BYTES) throw new Error('Photos must be 100 MiB or smaller.');
    const header = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
    const supplied = blob.type.toLowerCase().split(';')[0];
    let type = imageTypeFromHeader(header) || (supplied === 'image/jpg' ? 'image/jpeg' : supplied);
    if (!type || type === 'application/octet-stream') {
      const extension = name.split('.').pop()?.toLowerCase();
      type = ({ jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', heic:'image/heic', heif:'image/heic', avif:'image/avif' } as Record<string,string>)[extension || ''];
    }
    if (/^image\/hei[cf](?:-sequence)?$/.test(type) || type === 'image/avif') {
      const converted = await jpegPhoto(blob.slice(0, blob.size, type), type.startsWith('image/hei') ? 'image/heic' : type);
      if (converted.type !== 'image/jpeg' || converted.size > MAX_FILE_BYTES) throw new Error('Could not create a compatible photo under 100 MiB.');
      return { blob: converted, name: name.replace(/\.[^.]+$/, '') + '.jpg', changed: true };
    }
    if (!SUPPORTED_TYPES.has(type)) throw new Error('Choose a PNG, JPEG, GIF, WebP, HEIC/HEIF or AVIF photo.');
    let image = blob;
    if (type === 'image/jpeg' && !options.keepJpegBytes) {
      const length = jpegStillLength(new Uint8Array(await blob.arrayBuffer()));
      if (length && length < blob.size) image = blob.slice(0, length, type);
    }
    if (image.type !== type) image = image.slice(0, image.size, type);
    return { blob: image, name, changed: image !== blob };
  });
  preparationQueue = work.catch(() => undefined);
  return work;
}
