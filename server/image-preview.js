const fs = require('node:fs/promises');
const sharp = require('sharp');
// Overview photos need raster decoders only, not SVG/PDF or other document
// loaders. Unrecognized inputs retain the existing original-file behavior.
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpeg', 'VipsForeignLoadPng', 'VipsForeignLoadWebp',
  'VipsForeignLoadGif', 'VipsForeignLoadTiff', 'VipsForeignLoadHeif'] });
const sizes = new Set([160, 320, 480, 640, 960]);
const cache = new Map();
const pending = new Map();
let active = 0;
let cacheBytes = 0;
const waiting = [];

// Originals stay untouched. Bounded, transient previews require no disk cache
// or extra quota allocation. Authorization always happens before this helper.
async function imagePreview(filePath, size) {
  if (!sizes.has(size)) return null;
  const stat = await fs.stat(filePath);
  const key = `${filePath}|${stat.mtimeMs}|${stat.size}|${size}`;
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
  if (pending.has(key)) return pending.get(key);
  // Avoid unbounded decoder work under concurrent requests. The caller can
  // safely serve the original if a preview cannot be generated right now.
  if (waiting.length >= 24) return null;
  const job = (async () => {
    if (active >= 2) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try {
      const data = await sharp(filePath, { limitInputPixels: 100_000_000, page: 0, pages: 1 })
        .rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 }).timeout({ seconds: 5 }).toBuffer();
      cache.set(key, data);
      cacheBytes += data.length;
      while (cache.size > 96 || cacheBytes > 16 * 1024 * 1024) {
        const oldest = cache.keys().next().value;
        cacheBytes -= cache.get(oldest).length;
        cache.delete(oldest);
      }
      return data;
    } catch { return null; }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
      pending.delete(key);
    }
  })();
  pending.set(key, job);
  return job;
}
module.exports = { imagePreview };
