import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, isSha256Hex, verifySha256 } from '../public/checksum.js';

test('SHA-256 matches known bytes, Blob, and empty file', async () => {
  const hello = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  assert.equal(await sha256Hex(new TextEncoder().encode('hello').buffer), hello);
  assert.equal(await sha256Hex(new Blob(['hello'])), hello);
  assert.equal(await sha256Hex(new Blob([])),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('SHA-256 accepts only lowercase 64-character digest tokens', () => {
  assert.equal(isSha256Hex('f'.repeat(64)), true);
  assert.equal(isSha256Hex('F'.repeat(64)), false);
  assert.equal(isSha256Hex('g'.repeat(64)), false);
  assert.equal(isSha256Hex('a'.repeat(63)), false);
  assert.equal(isSha256Hex(null), false);
});

test('checksum rejects changed payload, mismatched and malformed hash', async () => {
  const original = new Blob(['hello']);
  const expected = await sha256Hex(original);
  assert.equal(await verifySha256(original, expected), true);
  assert.equal(await verifySha256(new Blob(['HELLO']), expected), false);
  assert.equal(await verifySha256(original, '0'.repeat(64)), false);
  assert.equal(await verifySha256(original, 'not-a-hash'), false);
});
