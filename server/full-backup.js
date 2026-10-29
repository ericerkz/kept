const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const sqlite3 = require('sqlite3');
const { Reader, ZipReader, ZipWriter, TextReader } = require('@zip.js/zip.js');

const FORMAT = 'kept-server-backup';
const MAX_ENTRIES = 200000;
const MANIFEST_LIMIT = 64 * 1024 * 1024;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function safeEntry(name) {
  if (typeof name !== 'string' || name.includes('\\') || name.includes('\0')) return false;
  if (name === 'kept.sqlite' || name === 'manifest.json' || name === 'vapid.json') return true;
  const parts = name.split('/');
  return ['uploads', 'attachments'].includes(parts[0]) && parts.length > 1 &&
    parts.every(part => part && part !== '.' && part !== '..' && !part.includes(':'));
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyMedia(source, target, prefix, entries) {
  const root = await fs.promises.lstat(source);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Backup media storage must be a directory.');
  await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
  for (const item of await fs.promises.readdir(source, { withFileTypes: true })) {
    const name = `${prefix}/${item.name}`;
    if (!safeEntry(name)) throw new Error('Backup media contains an unsupported filename.');
    const from = path.join(source, item.name), to = path.join(target, item.name);
    const stat = await fs.promises.lstat(from);
    if (stat.isDirectory()) await copyMedia(from, to, name, entries);
    else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup media contains a link or special file.');
      // Immutable upload filenames can be copied while the database lock keeps
      // note/media mutations from passing the snapshot boundary.
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      entries.push({ path: name, size: (await fs.promises.stat(to)).size });
    }
    if (entries.length > MAX_ENTRIES) throw new Error('Too many files for a single server backup.');
  }
}

async function createFullBackup({ backupDir, uploadDir, attachmentDir, version, vapidKeys, snapshot }) {
  for (const media of [uploadDir, attachmentDir]) {
    const root = path.resolve(media), backup = path.resolve(backupDir);
    if (backup === root || backup.startsWith(root + path.sep)) throw new Error('The backup directory cannot be inside a media directory.');
  }
  await fs.promises.mkdir(backupDir, { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(backupDir, '.full-'));
  const filename = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}-full.zip`;
  const destination = path.join(backupDir, filename);
  const partial = path.join(stage, 'archive.zip');
  let output;
  try {
    const entries = [];
    // The caller takes one database lock around the snapshot and media staging.
    await snapshot(path.join(stage, 'kept.sqlite'), async () => {
      entries.push({ path: 'kept.sqlite', size: (await fs.promises.stat(path.join(stage, 'kept.sqlite'))).size });
      await copyMedia(uploadDir, path.join(stage, 'uploads'), 'uploads', entries);
      await copyMedia(attachmentDir, path.join(stage, 'attachments'), 'attachments', entries);
      if (vapidKeys) {
        const identity = Buffer.from(JSON.stringify(vapidKeys));
        await fs.promises.writeFile(path.join(stage, 'vapid.json'), identity, { flag: 'wx', mode: 0o600 });
        entries.push({ path: 'vapid.json', size: identity.length });
      }
    });
    const manifest = { format: FORMAT, version: 1, appVersion: version, createdAt: new Date().toISOString(), entries };
    output = fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 });
    // Install the error observer before writing; never buffer the archive in RAM.
    const completed = finished(output);
    completed.catch(() => {});
    const writer = new ZipWriter(Writable.toWeb(output), { useWebWorkers: false, level: 0 });
    for (const entry of entries) {
      const file = path.join(stage, entry.path);
      entry.sha256 = await hashFile(file);
      await writer.add(entry.path, Readable.toWeb(fs.createReadStream(file)), { uncompressedSize: entry.size });
    }
    const metadata = JSON.stringify(manifest);
    if (Buffer.byteLength(metadata) > MANIFEST_LIMIT) throw new Error('The backup contains too many file records.');
    await writer.add('manifest.json', new TextReader(metadata));
    await writer.close();
    await completed;
    await fs.promises.rename(partial, destination);
    return { filename, size: (await fs.promises.stat(destination)).size };
  } catch (error) {
    output?.destroy();
    throw error;
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true });
  }
}

class FileReader extends Reader {
  constructor(handle, size) { super(); this.handle = handle; this.size = size; }
  async readUint8Array(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) throw invalid('The backup archive is truncated.');
    const data = new Uint8Array(length);
    let position = 0;
    while (position < length) {
      const { bytesRead } = await this.handle.read(data, position, length - position, offset + position);
      if (!bytesRead) throw invalid('The backup archive is truncated.');
      position += bytesRead;
    }
    return data;
  }
}

async function validateDatabase(filename) {
  const header = Buffer.alloc(16);
  const file = await fs.promises.open(filename, 'r');
  try { await file.read(header, 0, 16, 0); } finally { await file.close(); }
  if (!header.equals(SQLITE_HEADER)) throw invalid('The backup does not contain a valid SQLite database.');
  let database;
  try {
    database = await new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(connection));
    });
    const query = sql => new Promise((resolve, reject) => database.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
    const checks = await query('PRAGMA quick_check');
    if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') throw invalid('The backup database is damaged.');
    const tables = await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'notes')");
    if (tables.length !== 2) throw invalid('This SQLite file is not a Kept server backup.');
  } catch (error) {
    throw invalid(error.status === 400 ? error.message : 'The backup database could not be validated.');
  } finally {
    if (database) await new Promise(resolve => database.close(resolve));
  }
}

async function prepareRestore({ source, stage, maxBytes, quotaBytes }) {
  const handle = await fs.promises.open(source, 'r');
  let reader;
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) throw invalid('The backup exceeds the server restore size limit.');
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    if (header.equals(SQLITE_HEADER)) {
      if (quotaBytes && stat.size > quotaBytes) throw Object.assign(new Error('The backup exceeds this server’s storage allocation.'), { status: 507 });
      await fs.promises.copyFile(source, path.join(stage, 'kept.sqlite'), fs.constants.COPYFILE_EXCL);
      await validateDatabase(path.join(stage, 'kept.sqlite'));
      return { full: false };
    }
    reader = new ZipReader(new FileReader(handle, stat.size), {
      useWebWorkers: false, checkSignature: true, checkOverlappingEntry: true
    });
    const entries = new Map();
    for await (const entry of reader.getEntriesGenerator()) {
      const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (entry.directory || entry.encrypted || (unixType && unixType !== 0x8000) ||
          !safeEntry(entry.filename) || entries.has(entry.filename) || entries.size >= MAX_ENTRIES + 1 ||
          !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        throw invalid('The backup contains an unsafe, duplicate, or unsupported ZIP entry.');
      }
      entries.set(entry.filename, entry);
    }
    const metadata = entries.get('manifest.json');
    if (!metadata || metadata.uncompressedSize > MANIFEST_LIMIT) throw invalid('The server backup manifest is missing or too large.');
    const chunks = [];
    let manifestSize = 0;
    await metadata.getData(new WritableStream({ write(chunk) {
      manifestSize += chunk.length;
      if (manifestSize > MANIFEST_LIMIT || manifestSize > metadata.uncompressedSize) throw invalid('The backup manifest is too large.');
      chunks.push(Buffer.from(chunk));
    } }));
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (manifest.format !== FORMAT || manifest.version !== 1 || !Array.isArray(manifest.entries) ||
        manifest.entries.length + 1 !== entries.size) throw invalid('This is not a supported full Kept server backup.');
    const seen = new Set();
    let total = 0;
    for (const item of manifest.entries) {
      const entry = entries.get(item?.path);
      if (!entry || item.path === 'manifest.json' || seen.has(item.path) || !Number.isSafeInteger(item.size) ||
          item.size < 0 || item.size !== entry.uncompressedSize || !/^[a-f0-9]{64}$/.test(item.sha256)) {
        throw invalid('The server backup has invalid or incomplete file metadata.');
      }
      if (item.path === 'vapid.json' && item.size > 4096) throw invalid('The web-push key file is too large.');
      seen.add(item.path);
      total += item.size;
      if (!Number.isSafeInteger(total) || total > maxBytes) throw invalid('The expanded backup exceeds the server restore size limit.');
    }
    if (!seen.has('kept.sqlite')) throw invalid('The server backup database is missing.');
    if (quotaBytes && total > quotaBytes) throw Object.assign(new Error('The backup exceeds this server’s storage allocation.'), { status: 507 });
    await fs.promises.mkdir(path.join(stage, 'uploads'), { mode: 0o700 });
    await fs.promises.mkdir(path.join(stage, 'attachments'), { mode: 0o700 });
    for (const item of manifest.entries) {
      const destination = path.join(stage, item.path);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const file = await fs.promises.open(destination, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      let size = 0;
      try {
        await entries.get(item.path).getData(new WritableStream({ async write(chunk) {
          size += chunk.length;
          if (size > item.size) throw invalid('A backup file exceeds its declared size.');
          hash.update(chunk);
          await file.writeFile(chunk);
        } }));
      } finally { await file.close(); }
      if (size !== item.size || hash.digest('hex') !== item.sha256) throw invalid('A backup file failed its integrity check.');
    }
    await validateDatabase(path.join(stage, 'kept.sqlite'));
    if (seen.has('vapid.json')) {
      const keys = JSON.parse(await fs.promises.readFile(path.join(stage, 'vapid.json'), 'utf8'));
      if (typeof keys.privateKey !== 'string' || typeof keys.publicKey !== 'string' || keys.privateKey.length > 128 || keys.publicKey.length > 128 ||
          Buffer.from(keys.privateKey, 'base64url').length !== 32 || Buffer.from(keys.publicKey, 'base64url').length !== 65) throw invalid('Invalid web-push keys in the backup.');
      const identity = crypto.createECDH('prime256v1');
      identity.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'));
      if (!identity.getPublicKey().equals(Buffer.from(keys.publicKey, 'base64url'))) throw invalid('Invalid web-push keys in the backup.');
    }
    return { full: true, vapid: seen.has('vapid.json') };
  } catch (error) {
    if (error.status || ['ENOSPC', 'EACCES', 'EIO'].includes(error.code)) throw error;
    throw invalid('The backup archive is invalid or damaged.');
  } finally {
    if (reader) await reader.close().catch(() => {});
    await handle.close();
  }
}

// Stage on each destination filesystem. Media roots may themselves be mount
// points, so keep those directories and exchange their children instead.
async function stageReplacements({ stage, dbPath, uploadDir, attachmentDir, vapidPath, full, vapid }) {
  if (full) {
    const paths = [dbPath, uploadDir, attachmentDir].map(item => path.resolve(item));
    if (paths.some((item, index) => paths.some((other, otherIndex) => index !== otherIndex &&
        (item === other || item.startsWith(other + path.sep))))) throw new Error('Database and media storage paths must not overlap for a full restore.');
  }
  const pairs = [[path.join(stage, 'kept.sqlite'), dbPath]];
  if (full) pairs.push([path.join(stage, 'uploads'), uploadDir], [path.join(stage, 'attachments'), attachmentDir]);
  if (vapid) pairs.push([path.join(stage, 'vapid.json'), vapidPath]);
  const replacements = [];
  try {
    for (const [source, target] of pairs) {
      const directory = (await fs.promises.lstat(source)).isDirectory();
      if (directory) await fs.promises.mkdir(target, { recursive: true });
      const parent = directory ? target : path.dirname(path.resolve(target));
      const temporary = await fs.promises.mkdtemp(path.join(parent, '.kept-restore-'));
      const replacement = { target, temporary, directory, next: path.join(temporary, 'next'), previous: path.join(temporary, 'previous'), moved: false, installed: false, movedChildren: [], installedChildren: [] };
      replacements.push(replacement);
      await fs.promises.cp(source, replacement.next, { recursive: true, force: false, errorOnExist: true });
    }
    return replacements;
  } catch (error) { await cleanupReplacements(replacements); throw error; }
}

async function installReplacements(replacements) {
  for (const item of replacements) {
    if (item.directory) {
      await fs.promises.mkdir(item.previous);
      for (const name of await fs.promises.readdir(item.target)) {
        if (name === path.basename(item.temporary)) continue;
        await fs.promises.rename(path.join(item.target, name), path.join(item.previous, name));
        item.movedChildren.push(name);
      }
      for (const name of await fs.promises.readdir(item.next)) {
        await fs.promises.rename(path.join(item.next, name), path.join(item.target, name));
        item.installedChildren.push(name);
      }
      continue;
    }
    try { await fs.promises.rename(item.target, item.previous); item.moved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.promises.rename(item.next, item.target);
    item.installed = true;
  }
}

async function rollbackReplacements(replacements) {
  for (const item of [...replacements].reverse()) {
    if (item.directory) {
      for (const name of item.installedChildren) await fs.promises.rm(path.join(item.target, name), { recursive: true, force: true });
      for (const name of item.movedChildren) await fs.promises.rename(path.join(item.previous, name), path.join(item.target, name));
      continue;
    }
    if (item.installed) await fs.promises.rm(item.target, { recursive: true, force: true });
    if (item.moved) await fs.promises.rename(item.previous, item.target);
  }
}

async function cleanupReplacements(replacements) {
  for (const item of replacements) await fs.promises.rm(item.temporary, { recursive: true, force: true });
}

module.exports = { createFullBackup, prepareRestore, stageReplacements, installReplacements, rollbackReplacements, cleanupReplacements };
