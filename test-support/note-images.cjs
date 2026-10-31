const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadNoteImages(overrides = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync('src/app/utils/note-images.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(source, { exports, Blob, Uint8Array, Uint8ClampedArray, ArrayBuffer, DataView,
    Error, Promise, Set, URL, setTimeout, clearTimeout, ...overrides,
    require(name) {
      if (name.endsWith('/upload-limits.json')) return { default: require('../shared/upload-limits.json') };
      throw new Error(`Unexpected image preparation dependency: ${name}`);
    }
  });
  return exports;
}
module.exports = { loadNoteImages };
