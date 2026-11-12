const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const exportsForTest = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/utils/sync-status.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports: exportsForTest, Date, require: () => require('../test-support/i18n.cjs') });
const describe = exportsForTest.describeSyncStatus;
const last = new Date('2026-11-06T14:59:00Z').getTime();

test('healthy accounts have no indicator and show the localized sync time only in their menu', () => {
  const result = describe('saved', 0, last, false);
  assert.equal(result.attention, false);
  assert.equal(result.syncing, false);
  assert.equal(result.label, `Synced ${new Date(last).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`);
  assert.equal(result.action, 'Sync now');
  assert.equal(result.disabled, false);
});

test('ordinary syncing shows the ring and a count without a problem dot', () => {
  const result = describe('syncing', 3, last, false);
  assert.equal(result.syncing, true);
  assert.equal(result.attention, false);
  assert.equal(result.label, 'Syncing 3 changes…');
  assert.equal(result.disabled, true);
  assert.equal(describe('syncing', 0, last, false).label, 'Syncing…');
});

test('offline queued edits, failed syncs and storage blocks explain the amber dot and offer Retry', () => {
  const offline = describe('offline', 3, last, false);
  assert.equal(offline.label, '3 changes waiting');
  assert.match(offline.detail, /^Offline · last synced /);
  assert.equal(offline.attention, true);
  assert.equal(offline.action, 'Retry');
  const error = describe('error', 3, last, false);
  assert.equal(error.label, "Couldn't sync · 3 waiting");
  assert.equal(error.attention, true);
  assert.equal(error.action, 'Retry');
  const storage = describe('saved', 3, last, true);
  assert.equal(storage.label, 'Storage full · 3 waiting');
  assert.equal(storage.attention, true);
  assert.equal(storage.action, 'Retry');
});

test('no invented timestamps or problem dots just for being offline with nothing queued', () => {
  assert.equal(describe('saved', 0, null, false).label, 'Not synced yet');
  const offline = describe('offline', 0, null, false);
  assert.equal(offline.label, 'Offline');
  assert.equal(offline.detail, 'Not synced yet');
  assert.equal(offline.attention, false);
  assert.equal(describe('error', 0, null, false).attention, true);
  assert.equal(describe('saved', 1, last, false).label, '1 change waiting');
  assert.equal(describe('saved', 1, last, false).attention, true);
  assert.equal(describe('offline', 1, last, false, true).disabled, true);
  const retry = describe('error', 3, last, false, true);
  assert.equal(retry.syncing, true);
  assert.equal(retry.attention, false);
  assert.equal(retry.label, 'Syncing 3 changes…');
  assert.equal(describe('offline', 3, last, false, true).attention, true);
});
