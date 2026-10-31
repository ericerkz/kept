const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { readTakeoutZip } = require('./takeout-zip');
const { ZipWriter, TextReader, Uint8ArrayWriter } = require('@zip.js/zip.js');

async function withArchive(files, options, run, change = bytes => bytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kept-takeout-'));
  let archive;
  try {
    const zip = new AdmZip();
    for (const [name, data] of Object.entries(files)) zip.addFile(name, Buffer.from(data));
    const filename = path.join(directory, 'takeout.zip');
    await fs.writeFile(filename, change(zip.toBuffer()));
    archive = await readTakeoutZip(filename, options);
    await run(archive.entries);
  } finally {
    await archive?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('Takeout entries retain Unicode names and binary contents', async () => {
  await withArchive({ 'Takeout/Keep/Café.json': '{"title":"Café"}', 'Takeout/Keep/photo.png': '\0photo' }, {}, async entries => {
    assert.equal(entries.length, 2);
    for (const entry of entries) assert.equal((await entry.getData()).length, entry.size);
    assert.equal((await entries.find(entry => entry.entryName.endsWith('.json')).getData()).toString(), '{"title":"Café"}');
  });
});

test('declared entry and total limits are checked before buffering output', async () => {
  await withArchive({ 'large.json': 'x'.repeat(100) }, { maxEntryBytes: 50 }, async entries => {
    await assert.rejects(entries[0].getData(), { code: 'TAKEOUT_LIMIT' });
  });
  await withArchive({ 'a.json': 'a'.repeat(40), 'b.json': 'b'.repeat(40) }, { maxTotalBytes: 60 }, async entries => {
    assert.equal((await entries[0].getData()).length, 40);
    await assert.rejects(entries[1].getData(), { code: 'TAKEOUT_LIMIT' });
  });
});

test('a forged zero size cannot bypass the streaming output limit', async () => {
  await withArchive({ 'bomb.json': 'x'.repeat(4096) }, { maxEntryBytes: 100 }, async entries => {
    assert.equal(entries[0].size, 0);
    await assert.rejects(entries[0].getData());
  }, bytes => {
    bytes.writeUInt32LE(0, 22); // Local uncompressed size.
    bytes.writeUInt32LE(0, bytes.indexOf(Buffer.from('PK\x01\x02', 'binary')) + 24);
    return bytes;
  });
});

test('entry-count limits stop directory enumeration', async () => {
  await assert.rejects(withArchive({ 'a.json': 'a', 'b.json': 'b' }, { maxEntries: 1 }, async () => {}), { code: 'TAKEOUT_LIMIT' });
});

test('stored ZIP64 archives with data descriptors are supported', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kept-takeout-'));
  let archive;
  try {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { zip64: true, level: 0, useWebWorkers: false });
    await writer.add('Takeout/Keep/note.json', new TextReader('{"title":"Stored ZIP64"}'));
    const filename = path.join(directory, 'takeout.zip');
    await fs.writeFile(filename, await writer.close());
    archive = await readTakeoutZip(filename);
    assert.equal((await archive.entries[0].getData()).toString(), '{"title":"Stored ZIP64"}');
  } finally {
    await archive?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
