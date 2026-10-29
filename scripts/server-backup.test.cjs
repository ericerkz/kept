const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const rx = require('rxjs');

const code = ts.transpileModule(fs.readFileSync('src/app/services/server-backup.service.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

function harness({ native = true, failChunk = -1, ignoreRange = false, badRange = false, available = true } = {}) {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 37000, 23), written = [], requests = [], events = [];
  const auth = {
    createFullBackup: async () => ({ filename: 'backup-test-full.zip', size: bytes.length }),
    authHeaders: () => ({ set: (name, value) => new Map([['Authorization', 'Bearer native-token'], [name, value]]) })
  };
  const plugin = {
    beginExport: async () => { events.push('begin'); return { reference: 'file' }; },
    writeExportChunk: async ({ reference, offset, base64 }) => {
      assert.equal(reference, 'file');
      assert.equal(offset, written.reduce((size, item) => size + item.length, 0));
      written.push(Buffer.from(base64, 'base64'));
    },
    finishExport: async () => events.push('finish'),
    abortExport: async () => events.push('abort')
  };
  const exports = {};
  const link = { click: () => events.push('click'), remove() {} };
  vm.runInNewContext(code, { exports, Uint8Array, Number, Error,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    document: { createElement: () => link, body: { appendChild() {} } },
    require(name) {
      if (name === '@angular/core') return { Injectable: () => target => target };
      if (name === '@capacitor/core') return { Capacitor: { isNativePlatform: () => native } };
      if (name === 'rxjs') return rx;
      if (name.endsWith('/environment')) return { environment: { apiUrl: 'https://server.test/api' } };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const http = { get(url, options) {
    requests.push({ url, options });
    assert.equal(options.headers.get('Authorization'), 'Bearer native-token');
    if (requests.length - 1 === failChunk) return rx.throwError(() => new Error('Disconnected'));
    const [, start, end] = options.headers.get('Range').match(/^bytes=(\d+)-(\d+)$/).map(Number);
    const chunk = bytes.subarray(start, end + 1);
    return rx.of({ status: ignoreRange ? 200 : 206,
      headers: new Map([['Content-Range', badRange ? 'bytes 0-99/100' : `bytes ${start}-${end}/${bytes.length}`]]),
      body: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length) });
  } };
  const service = new exports.ServerBackupService(http, auth, {
    ready: Promise.resolve(), plugin: available ? plugin : null, capabilities$: { value: { streamingFiles: available } }
  });
  return { service, bytes, written, requests, events, link };
}

test('native server backups use bounded authenticated chunks and the existing file export bridge', async () => {
  const h = harness();
  await h.service.createAndDownload();
  assert.deepEqual(Buffer.concat(h.written), h.bytes);
  assert.equal(h.requests.length, 2);
  assert.ok(h.written.every(chunk => chunk.length <= 256 * 1024));
  assert.deepEqual(h.events, ['begin', 'finish']);
  assert.ok(h.requests.every(request => !request.url.includes('token=')));
});

test('native download failures and invalid range responses abort instead of saving incomplete backups', async () => {
  for (const options of [{ failChunk: 1 }, { ignoreRange: true }, { badRange: true }]) {
    const h = harness(options);
    await assert.rejects(h.service.createAndDownload());
    assert.deepEqual(h.events, ['begin', 'abort']);
  }
});

test('native clients without the file bridge get an actionable error', async () => {
  const h = harness({ available: false });
  await assert.rejects(h.service.createAndDownload(), /Update the native Kept app/);
  assert.equal(h.requests.length, 0);
});

test('web downloads use the authenticated browser download without buffering the archive', async () => {
  const h = harness({ native: false });
  await h.service.createAndDownload();
  assert.equal(h.requests.length, 0);
  assert.equal(h.link.href, 'https://server.test/api/admin/backup/download/backup-test-full.zip');
  assert.equal(h.link.download, 'backup-test-full.zip');
  assert.deepEqual(h.events, ['click']);
});
