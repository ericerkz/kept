const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { readTakeoutZip, findKeepJsonEntries } = require('./takeout-zip');
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

const keepNote = title => JSON.stringify({ title, textContent: 'Milch', isTrashed: false, userEditedTimestampUsec: 1700000000000000 });

test('a localized Keep folder is found by its note files', async () => {
  await withArchive({
    'Takeout/Google Notizen/Einkaufsliste.json': keepNote('Einkaufsliste'),
    'Takeout/Google Notizen/Einkaufsliste.html': '<html></html>',
    'Takeout/Google Notizen/Urlaub.json': keepNote('Urlaub'),
    'Takeout/Google Notizen/Urlaub.html': '<html></html>',
    'Takeout/Google Notizen/foto.png': '\0foto',
    'Takeout/Google Notizen/Labels.txt': 'Arbeit',
    'Takeout/Chrome/BrowserHistory.json': '{"Browser History":[]}',
    'Takeout/Google Fotos/Urlaub/IMG_0001.jpg.json': '{"title":"IMG_0001.jpg"}',
    'Takeout/archive_browser.html': '<html></html>'
  }, {}, async entries => {
    const names = (await findKeepJsonEntries(entries)).map(entry => entry.entryName).sort();
    assert.deepEqual(names, ['Takeout/Google Notizen/Einkaufsliste.json', 'Takeout/Google Notizen/Urlaub.json']);
  });
});

test('a folder named Keep is still used first', async () => {
  await withArchive({
    'Takeout/Keep/note.json': '{"title":"Plain"}',
    'Takeout/Google Notizen/Notiz.json': keepNote('Notiz'),
    'Takeout/Google Notizen/Notiz.html': '<html></html>'
  }, {}, async entries => {
    assert.deepEqual((await findKeepJsonEntries(entries)).map(entry => entry.entryName), ['Takeout/Keep/note.json']);
  });
});

test('paired JSON and HTML files that are not Keep notes are ignored', async () => {
  await withArchive({
    'Takeout/My Activity/Search/MyActivity.json': '[{"title":"Searched for kept"}]',
    'Takeout/My Activity/Search/MyActivity.html': '<html></html>',
    'Takeout/Other/report.json': '{"textContent":"no timestamp"}',
    'Takeout/Other/report.html': '<html></html>',
    'Takeout/Broken/note.json': '{not json',
    'Takeout/Broken/note.html': '<html></html>'
  }, {}, async entries => {
    assert.deepEqual(await findKeepJsonEntries(entries), []);
  });
});
