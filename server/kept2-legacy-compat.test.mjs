import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('kept2 legacy adapter is explicit, warning-gated, and temporary', () => {
  const adapterPath = path.join(root, 'src/app/kept2/legacy-server-adapter.ts');
  const source = fs.readFileSync(adapterPath, 'utf8');
  assert.match(source, /TEMPORARY KEPT 2\.0 LEGACY COMPATIBILITY LAYER/);
  assert.match(source, /DELETE IN KEPT 2\.1/);
  assert.match(source, /warningRequired:\s*true/);
  assert.match(source, /protocol:\s*'kept-1\.8\.1'/);
});

test('kept2 legacy runtime support has a deletion tripwire for 2.1', () => {
  const adapterPath = path.join(root, 'src/app/kept2/legacy-server-adapter.ts');
  const source = fs.readFileSync(adapterPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const majorMinor = String(packageJson.version || '0.0').split('.').slice(0, 2).join('.');
  if (majorMinor === '2.1') {
    assert.doesNotMatch(source, /LegacyServerAdapter|kept-1\.8\.1|legacyRuntime:\s*true/);
  } else {
    assert.match(source, /DELETE IN KEPT 2\.1/);
  }
});
