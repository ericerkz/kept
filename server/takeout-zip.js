const fs = require('node:fs');
const { BlobReader, ZipReader } = require('@zip.js/zip.js');

function limitError(message) {
  return Object.assign(new Error(message), { code: 'TAKEOUT_LIMIT', status: 400 });
}

// Read from disk and bound output as it is decompressed. Checking a completed
// Buffer's length is too late to stop a forged ZIP size or a compression bomb.
async function readTakeoutZip(filename, {
  maxEntries = 100_000,
  maxEntryBytes = 250 * 1024 * 1024,
  maxTotalBytes = 10 * 1024 * 1024 * 1024
} = {}) {
  const reader = new ZipReader(new BlobReader(await fs.openAsBlob(filename)), {
    useWebWorkers: false, checkSignature: true, checkOverlappingEntry: true
  });
  let totalExtracted = 0;
  const entries = [], seen = new Set();
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= maxEntries) throw limitError('ZIP has too many entries.');
      const name = entry.filename.replace(/\\/g, '/');
      if (!name || name.length > 1024 || name.includes('\0') || name.startsWith('/') ||
          /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || seen.has(name)) {
        throw limitError('ZIP contains an unsafe entry path or duplicate filename.');
      }
      seen.add(name);
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        throw limitError('ZIP contains an invalid entry size.');
      }
      entries.push({
        entryName: name, isDirectory: entry.directory, size: entry.uncompressedSize,
        getData: async () => {
          const remaining = maxTotalBytes - totalExtracted;
          if (entry.uncompressedSize > maxEntryBytes || entry.uncompressedSize > remaining) {
            throw limitError('ZIP entry is too large or expands beyond the safe extraction limit.');
          }
          let size = 0;
          const chunks = [];
          await entry.getData(new WritableStream({ write(chunk) {
            size += chunk.length;
            totalExtracted += chunk.length;
            if (size > maxEntryBytes || size > entry.uncompressedSize || totalExtracted > maxTotalBytes) {
              throw limitError('ZIP entry is too large or expands beyond the safe extraction limit.');
            }
            chunks.push(Buffer.from(chunk));
          } }));
          return Buffer.concat(chunks, size);
        }
      });
    }
    return { entries, close: () => reader.close() };
  } catch (error) {
    await reader.close();
    throw error;
  }
}

module.exports = { readTakeoutZip };
