const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function storageFull() {
  return Object.assign(new Error("Your server's storage is full - please upgrade or delete some files/images."), {
    status: 507, code: 'STORAGE_QUOTA_EXCEEDED'
  });
}

// Account for stored and in-flight file bytes before writing them. Database
// allocation is checked under the SQLite transaction lock, before commit.
class StorageQuota {
  constructor(limit) { this.limit = limit; this.ready = false; this.files = new Map(); this.fileBytes = 0; this.databaseBytes = 0; this.uploadQueue = Promise.resolve(); }
  get enabled() { return !!this.limit && this.ready; }
  get usedBytes() { return this.databaseBytes + this.fileBytes; }
  async initialize(databaseBytes, directories) {
    if (!this.limit) return;
    this.files.clear(); this.fileBytes = 0; this.databaseBytes = databaseBytes;
    const visit = async directory => {
      for (const item of await fs.promises.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) await visit(filename);
        else {
          const size = (await fs.promises.lstat(filename)).size;
          this.files.set(path.resolve(filename), size); this.fileBytes += size;
        }
      }
    };
    for (const directory of new Set(directories.map(value => path.resolve(value)))) await visit(directory);
    // A small, bounded reserve keeps sign-in and revocation available when the
    // data allocation is full, including an existing oversized installation.
    this.maintenanceLimit = Math.max(this.limit,this.usedBytes) + 1024 * 1024;
    this.ready = true;
  }
  resize(filename, size) {
    if (!this.enabled) return;
    filename = path.resolve(filename);
    const old = this.files.get(filename) || 0;
    const delta = size - old;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid storage reservation.');
    if (delta > 0 && this.usedBytes + delta > this.limit) throw storageFull();
    this.files.set(filename, size); this.fileBytes += delta;
  }
  forget(filename) {
    filename = path.resolve(filename);
    this.fileBytes -= this.files.get(filename) || 0; this.files.delete(filename);
  }
  removeSync(filename) {
    try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.forget(filename);
  }
  async remove(filename) {
    try { await fs.promises.unlink(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.forget(filename);
  }
  moveSync(source, destination) {
    // Finalization moves staging bytes rather than charging/copying the whole
    // library twice. A failed transaction can move them back for a safe retry.
    if (fs.existsSync(destination)) throw new Error('Transfer destination already exists.');
    const size = this.files.get(path.resolve(source)) ?? fs.statSync(source).size;
    try { fs.renameSync(source, destination); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      try { fs.unlinkSync(source); } catch (error) { fs.unlinkSync(destination); throw error; }
    }
    if (this.enabled) { this.forget(source); this.files.set(path.resolve(destination), size); this.fileBytes += size; }
  }
  checkDatabase(bytes, before, releasedBytes = 0, essential = false) {
    this.databaseBytes = bytes;
    // Existing oversized instances remain readable and may shrink/delete data.
    const after = this.usedBytes - releasedBytes;
    if (this.enabled && after > (essential ? this.maintenanceLimit : this.limit) && after > before) throw storageFull();
  }
  assertAdditional(bytes = 0) {
    if (this.enabled && this.usedBytes + bytes > this.limit) throw storageFull();
  }
  diskStorage({ destination, filename }) {
    const handle = (req, file, callback) => {
      destination(req, file, (error, directory) => {
        if (error) return callback(error);
        filename(req, file, (error, name) => {
          if (error) return callback(error);
          const target = path.join(directory, name);
          let size = 0;
          const meter = new Transform({ transform: (chunk, _encoding, done) => {
            try { this.resize(target, size + chunk.length); size += chunk.length; done(null, chunk); }
            catch (error) { done(error); }
          } });
          pipeline(file.stream, meter, fs.createWriteStream(target, { flags: 'wx' }))
            .then(() => callback(null, { destination: directory, filename: name, path: target, size }), async error => {
              try { await this.remove(target); } catch {}
              callback(error);
            });
        });
      });
    };
    return {
      _handleFile: (req, file, callback) => {
        if (!this.enabled) return handle(req,file,callback);
        // Avoid two near-full uploads consuming each other's remaining space
        // and both failing halfway through. Queued streams retain backpressure.
        const previous = this.uploadQueue;
        let release;
        this.uploadQueue = new Promise(resolve => { release = resolve; });
        previous.then(() => handle(req,file,(...args) => {
          try { callback(...args); } finally { release(); }
        })).catch(error => { release(); callback(error); });
      },
      _removeFile: (_req, file, callback) => { this.remove(file.path).then(() => callback(null), callback); }
    };
  }
}

module.exports = { StorageQuota, storageFull };
