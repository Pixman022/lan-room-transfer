import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPair, inspectSelectedPath, parseIPv4 } from '../public/route-policy.js';

const pair = (a, b, typeA = 'host', typeB = 'host') => assessPair(
  {candidateType: typeA, address: a}, {candidateType: typeB, address: b});

test('only same private /24 host pair can pass conservative gate', () => {
  assert.equal(pair('192.168.1.3', '192.168.1.44').allowed, true);
  assert.equal(pair('10.32.7.1', '10.32.7.2').allowed, true);
  assert.equal(pair('172.20.1.2', '172.20.1.60').allowed, true);
  assert.equal(pair('192.168.1.3', '192.168.2.3').allowed, false);
  assert.equal(pair('192.168.1.3', '10.0.0.4').allowed, false);
  assert.equal(pair('192.168.1.3', '192.168.1.3').allowed, false);
});

test('relay, public, loopback, mdns, ipv6 and opaque addresses fail closed', () => {
  assert.equal(pair('192.168.1.3', '192.168.1.4', 'host', 'relay').allowed, false);
  assert.equal(pair('192.168.1.3', '8.8.8.8').allowed, false);
  assert.equal(pair('127.0.0.1', '127.0.0.2').allowed, false);
  assert.equal(pair('test.local', '192.168.1.4').allowed, false);
  assert.equal(pair('fc00::1', 'fc00::2').allowed, false);
  assert.equal(pair('100.64.0.1', '100.64.0.2').allowed, false);
  assert.equal(pair(undefined, '192.168.1.4').allowed, false);
  assert.equal(parseIPv4('999.1.1.1'), null);
});

test('selected candidate stats must be readable and host/private', async () => {
  const good = new Map([
    ['transport', {type: 'transport', selectedCandidatePairId: 'p'}],
    ['p', {type: 'candidate-pair', localCandidateId: 'a', remoteCandidateId: 'b', state: 'succeeded'}],
    ['a', {type: 'local-candidate', candidateType: 'host', address: '192.168.50.2'}],
    ['b', {type: 'remote-candidate', candidateType: 'host', address: '192.168.50.17'}],
  ]);
  assert.equal((await inspectSelectedPath({getStats: async () => good})).allowed, true);
  good.set('b', {type: 'remote-candidate', candidateType: 'host', address: 'f00.local'});
  assert.equal((await inspectSelectedPath({getStats: async () => good})).allowed, false);
  assert.equal((await inspectSelectedPath({getStats: async () => new Map()})).allowed, false);
});
