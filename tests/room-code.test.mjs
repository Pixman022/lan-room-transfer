import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRandomRoomCode, normalizeRoomCode } from '../public/room-code.js';

test('suggested room code always contains four digits including leading zeros', () => {
  assert.equal(generateRandomRoomCode(values => { values[0] = 7; }), '0007');
  assert.equal(generateRandomRoomCode(values => { values[0] = 12345; }), '2345');
  assert.match(generateRandomRoomCode(), /^\d{4}$/);
});

test('single room code accepts numeric or custom alphanumeric values', () => {
  assert.equal(normalizeRoomCode(' 5832 '), '5832');
  assert.equal(normalizeRoomCode(' home2026 '), 'HOME2026');
  assert.equal(normalizeRoomCode('8888'), '8888');
  for (const invalid of ['abc', 'with-space', 'room_name', 'toolong0123456789', '']) {
    assert.throws(() => normalizeRoomCode(invalid));
  }
});
