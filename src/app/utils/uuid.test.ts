// node --test src/app/utils/uuid.test.ts
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createUuid } from './uuid.ts';

function useCrypto(t: TestContext, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
  t.after(() => Object.defineProperty(globalThis, 'crypto', original));
}

test('uses the existing randomUUID method with its receiver', t => {
  const provider = {
    randomUUID() {
      assert.equal(this, provider);
      return '01234567-89ab-4cde-8012-3456789abcde';
    },
    getRandomValues() { throw new Error('Fallback should not run.'); }
  };
  useCrypto(t, provider);
  assert.equal(createUuid(), '01234567-89ab-4cde-8012-3456789abcde');
});

for (const fillWithOnes of [false, true]) {
  test(`fallback preserves random bytes and sets UUID version/variant (${fillWithOnes ? 'all ones' : 'byte sequence'})`, t => {
    const provider = {
      getRandomValues(bytes: Uint8Array) {
        assert.equal(this, provider);
        assert.equal(bytes.length, 16);
        bytes.set(Array.from({ length: 16 }, (_, index) => fillWithOnes ? 255 : index));
        return bytes;
      }
    };
    useCrypto(t, provider);
    assert.equal(createUuid(), fillWithOnes
      ? 'ffffffff-ffff-4fff-bfff-ffffffffffff'
      : '00010203-0405-4607-8809-0a0b0c0d0e0f');
  });
}

test('fallback works with the real cryptographic random source', t => {
  useCrypto(t, { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const ids = Array.from({ length: 100 }, () => createUuid());
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, ids.length);
});

for (const provider of [undefined, {}]) {
  test(`fails safely without a secure random source (${provider ? 'missing methods' : 'missing crypto'})`, t => {
    useCrypto(t, provider);
    assert.throws(createUuid, /Secure random number generation is unavailable/);
  });
}

test('does not hide a failure from the secure random source', t => {
  const failure = new Error('Random source failed.');
  useCrypto(t, { getRandomValues() { throw failure; } });
  assert.throws(createUuid, error => error === failure);
});
