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

function isKeepJsonEntry(entry) {
  return !entry.isDirectory && /(^|\/)(?:Takeout\/)?Keep\/[^/]+\.json$/i.test(entry.entryName);
}

// A Google Keep note is exported as NOTE.json next to NOTE.html.
function noteFiles(entries) {
  const folders = new Map();
  for (const entry of entries) {
    const match = !entry.isDirectory && /^(.*\/)?([^/]+)\.(json|html)$/i.exec(entry.entryName);
    if (!match) continue;
    const [, folder = '', name, extension] = match;
    if (!folders.has(folder)) folders.set(folder, { json: new Map(), html: new Set() });
    const files = folders.get(folder);
    if (extension.toLowerCase() === 'json') files.json.set(name, entry);
    else files.html.add(name);
  }
  return folders;
}

async function isKeepNote(entry) {
  let note;
  try { note = JSON.parse((await entry.getData()).toString('utf8')); }
  catch (error) {
    if (error?.code === 'TAKEOUT_LIMIT') throw error;
    return false;
  }
  return !!note && typeof note === 'object' && !Array.isArray(note) &&
    ('textContent' in note || 'listContent' in note) && 'userEditedTimestampUsec' in note;
}

// Takeout names the Keep folder in the account's language (for example
// "Google Notizen" in German). Prefer a folder named Keep, otherwise find the
// folder by its contents: paired NOTE.json/NOTE.html files with Keep note fields.
async function findKeepJsonEntries(entries, { maxSamples = 3 } = {}) {
  const named = entries.filter(isKeepJsonEntry);
  if (named.length) return named;
  const found = [];
  for (const { json, html } of noteFiles(entries).values()) {
    const samples = [...json.keys()].filter(name => html.has(name)).slice(0, maxSamples);
    for (const name of samples) {
      if (await isKeepNote(json.get(name))) {
        found.push(...json.values());
        break;
      }
    }
  }
  return found;
}

module.exports = { readTakeoutZip, findKeepJsonEntries };
