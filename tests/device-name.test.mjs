import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_NAME_KEY, deviceAvatar, generateDeviceName, getOrCreateDeviceName } from '../public/device-name.js';

function sequence(...numbers) {
  let index = 0;
  return () => numbers[index++];
}
function fakeStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('first visit receives a Color Animal name, without unnecessary numeric suffix', () => {
  const storage = fakeStorage();
  const name = getOrCreateDeviceName(storage, sequence(0, 0));
  assert.equal(name, 'Amber Bear');
  assert.equal(storage.getItem(DEVICE_NAME_KEY), name);
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
});

test('reload reuses stored user-chosen name', () => {
  const storage = fakeStorage();
  const name = getOrCreateDeviceName(storage, sequence(0.4, 0.1234));
  assert.equal(getOrCreateDeviceName(storage, () => 0.99), name);
  storage.setItem(DEVICE_NAME_KEY, 'My Tablet');
  assert.equal(getOrCreateDeviceName(storage, () => 0.99), 'My Tablet');
});

test('missing or blank stored name regenerates default', () => {
  const storage = fakeStorage();
  storage.setItem(DEVICE_NAME_KEY, '  ');
  assert.equal(getOrCreateDeviceName(storage, sequence(0, 1 / 16)), 'Amber Cat');
});

test('migrate old generated Chinese name but preserve user-edited names', () => {
  const storage = fakeStorage();
  storage.setItem(DEVICE_NAME_KEY, '云雀-4827');
  assert.equal(getOrCreateDeviceName(storage, sequence(0, 0)), 'Amber Bear');
  storage.setItem(DEVICE_NAME_KEY, '我的电脑');
  assert.equal(getOrCreateDeviceName(storage, () => 0.99), '我的电脑');
});

test('storage disabled still returns a valid generated name', () => {
  const storage = {
    getItem() { throw new Error('access denied'); },
    setItem() { throw new Error('access denied'); },
  };
  assert.equal(getOrCreateDeviceName(storage, sequence(0, 0)), 'Amber Bear');
});

test('all possible generated names remain short and use English words', () => {
  for (let i = 0; i < 256; i += 1) {
    const name = generateDeviceName(sequence(Math.floor(i / 16) / 16, (i % 16) / 16));
    assert.ok(name.length <= 40);
    assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  }
});

test('animal avatar uses the last word; custom name is neutral', () => {
  assert.equal(deviceAvatar('Blue Fox'), '🦊');
  assert.equal(deviceAvatar('Silver Otter'), '🦦');
  assert.equal(deviceAvatar('My Laptop'), '🐾');
});
