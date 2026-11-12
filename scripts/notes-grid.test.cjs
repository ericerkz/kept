const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/app/components/notes/notes.component.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

function layout({ width, native = true, phone = false, foldable = false, view = 'grid' }) {
  const exports = {}, packs = [], properties = new Map();
  vm.runInNewContext(source, {
    exports, console, window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: { style: { setProperty: (key, value) => properties.set(key, value) } } },
    getComputedStyle: () => ({ paddingLeft: '10px', paddingRight: '10px' }),
    requestAnimationFrame: callback => callback(),
    require(name) {
      if (name === '@angular/core') return { Component: () => value => value,
        ViewChild: () => () => {}, ViewChildren: () => () => {}, HostListener: () => () => {} };
      if (name === '@capacitor/core') return { registerPlugin: () => ({}), Capacitor: { isNativePlatform: () => native } };
      if (name.endsWith('/platform')) return { isNativePhonePlatform: () => phone, isExpandedNativeFoldable: () => foldable };
      if (name === 'bricks.js') return { default: options => ({ pack: () => packs.push(options) }) };
      return {};
    }
  });
  const component = Object.create(exports.NotesComponent.prototype);
  const node = { style: {} };
  component.Shared = { noteViewType: { value: view } };
  component.mainContainer = { nativeElement: { clientWidth: width } };
  component.noteEl = { toArray: () => [{ nativeElement: node }] };
  component.title = [];
  component.buildMasonry();
  return { columns: packs[0].sizes[0].columns, cardWidth: component.noteWidth };
}

test('native tablet portrait fits three readable columns after navigation and container padding', () => {
  // 820px iPad portrait viewport, minus the collapsed 80px rail and 20px page padding.
  const result = layout({ width: 720 });
  assert.equal(result.columns, 3);
  assert.ok(result.cardWidth >= 190);
  assert.ok(result.cardWidth * 3 + 20 <= 700);
  assert.equal(layout({ width: 630 }).columns, 3, 'three columns still fit at the minimum content width');
  assert.equal(layout({ width: 629 }).columns, 2, 'narrower split windows retain two readable columns');
});

test('larger tablets, phones, foldables, desktop and list view retain their layout rules', () => {
  assert.equal(layout({ width: 1080 }).columns, 4, 'landscape tablet keeps its larger grid');
  assert.equal(layout({ width: 390, phone: true }).columns, 2);
  assert.equal(layout({ width: 720, phone: true, foldable: true }).columns, 3);
  assert.equal(layout({ width: 720, native: false }).columns, 2);
  const list = layout({ width: 720, view: 'list' });
  assert.equal(list.columns, 1);
  assert.equal(list.cardWidth, 600);
});
