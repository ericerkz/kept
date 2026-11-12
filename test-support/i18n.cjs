// Exercise the real message formatter without bootstrapping Angular in service tests.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { messagesFor, readCatalogue } = require('../scripts/translations.mjs');
const english = messagesFor(readCatalogue('en'), 'shared');
const exportsForTest = {};
const source = fs.readFileSync(path.join(__dirname, '../src/app/i18n/messages.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, { exports: exportsForTest, Intl, Date, require(name) {
  if (name.endsWith('/en.json')) return english;
  throw new Error(`Unexpected formatter import: ${name}`);
} });
module.exports = { ...exportsForTest, english };
