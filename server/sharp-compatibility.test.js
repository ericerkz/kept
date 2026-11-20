const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('portable image decoding is a required production dependency matching sharp', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  assert.equal(pkg.dependencies['@img/sharp-wasm32'], pkg.dependencies.sharp);
  assert.equal(lock.packages[''].dependencies['@img/sharp-wasm32'], pkg.dependencies.sharp);
  assert.equal(lock.packages['node_modules/@img/sharp-wasm32'].version, pkg.dependencies.sharp);
  assert.notEqual(lock.packages['node_modules/@img/sharp-wasm32'].optional, true);
  assert.notEqual(lock.packages['node_modules/@img/sharp-wasm32'].dev, true);
});

test('server startup and image previews work when the native Linux binary rejects an older CPU', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kept-sharp-compat-'));
  try {
    const preload = path.join(directory, 'older-cpu.cjs');
    // Exercise sharp's real fallback loader and real WebAssembly decoder. Only
    // its native CPU probe is substituted; preview generation, authorization,
    // disabled document loaders and the fixture server run unchanged.
    await writeFile(preload, String.raw`
      const Module = require('node:module');
      const assert = require('node:assert/strict');
      const load = Module._load;
      let requested = false, rejected = 0, portable = 0;
      Module._load = function(request, parent, isMain) {
        if (request === 'sharp') requested = true;
        if (request === './libvips.cjs' && /[\\/]sharp[\\/]dist[\\/]sharp\.cjs$/.test(parent?.filename || '')) {
          return { ...load.apply(this, arguments), runtimePlatformArch: () => 'linuxmusl-x64' };
        }
        if (request === '@img/sharp-linuxmusl-x64/sharp.node') return { _isUsingX64V2: () => { rejected++; return false; } };
        if (request === '@img/sharp-wasm32/sharp.node') portable++;
        return load.apply(this, arguments);
      };
      process.on('exit', () => {
        if (requested) { assert.ok(rejected > 0, 'native CPU rejection was exercised'); assert.ok(portable > 0, 'the portable decoder was loaded'); }
      });
    `);
    const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}` };
    delete env.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(process.execPath,
      ['--test', '--test-reporter=tap', 'server/image-preview.test.js'], {
        cwd: path.join(__dirname, '..'), timeout: 50000, maxBuffer: 2 * 1024 * 1024,
        env
      });
    assert.match(result.stdout, /# pass 2\b/);
    assert.match(result.stdout, /# fail 0\b/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
