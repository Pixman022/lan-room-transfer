import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPair, candidateAddressKind, inspectSelectedPath, isHostCandidateLine, parseIPv4 } from '../public/route-policy.js';

test('host ICE candidate is accepted with or without trailing attributes', () => {
  const host = 'candidate:1 1 udp 100 192.168.1.5 5555 typ host';
  assert.equal(isHostCandidateLine(host), true);
  assert.equal(isHostCandidateLine(host + ' generation 0'), true);
  assert.equal(isHostCandidateLine(host.replace('typ host', 'typ srflx')), false);
  assert.equal(isHostCandidateLine(host.replace('typ host', 'typ relay')), false);
  assert.equal(isHostCandidateLine(''), false);
});

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

test('restricted P2P accepts masked host addresses but not explicit unsafe paths', () => {
  assert.equal(pair('192.168.1.3', '192.168.1.4', 'host', 'relay').allowed, false);
  assert.equal(pair('192.168.1.3', '192.168.1.4', 'srflx', 'host').allowed, false);
  assert.equal(pair('192.168.1.3', '8.8.8.8').allowed, false);
  assert.equal(pair('127.0.0.1', '127.0.0.2').allowed, false);
  assert.equal(pair('test.local', '192.168.1.4').allowed, true);
  assert.equal(pair('test.local', '192.168.1.4').code, 'masked-host-p2p');
  assert.equal(pair(undefined, '192.168.1.4').allowed, true);
  assert.equal(pair(undefined, '192.168.1.4').code, 'masked-host-p2p');
  assert.equal(pair('test.local', undefined).allowed, true);
  assert.equal(pair(undefined, undefined).allowed, true);
  assert.equal(pair('0.0.0.0', '192.168.1.4').allowed, true);
  assert.equal(pair('192.168.1.4', '8.8.8.8').allowed, false);
  assert.equal(pair('8.8.8.8', undefined).allowed, false);
  assert.equal(pair('fc00::1', 'fc00::2').allowed, false);
  assert.equal(pair('100.64.0.1', '100.64.0.2').allowed, false);
  assert.equal(pair('machine.example', '192.168.1.4').allowed, false);
  assert.equal(pair('test.local', '192.168.1.4', 'host', 'relay').allowed, false);
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
  const mdns = await inspectSelectedPath({getStats: async () => good});
  assert.equal(mdns.allowed, true);
  assert.equal(mdns.code, 'masked-host-p2p');
  assert.equal(mdns.remoteAddressKind, 'mdns');
  assert.equal(mdns.localAddressKind, 'private-ipv4');
  good.set('b', {type: 'remote-candidate', candidateType: 'host', address: null});
  const hidden = await inspectSelectedPath({getStats: async () => good});
  assert.equal(hidden.allowed, true);
  assert.equal(hidden.code, 'masked-host-p2p');
  assert.equal(hidden.remoteAddressKind, 'hidden');
  good.set('b', {type: 'remote-candidate', candidateType: 'relay', address: null});
  assert.equal((await inspectSelectedPath({getStats: async () => good})).allowed, false);
  assert.equal(candidateAddressKind({address: '::'}), 'redacted');
  assert.equal(candidateAddressKind({address: '8.8.8.8'}), 'other-ipv4');
  assert.equal(candidateAddressKind({address: 'fc00::5'}), 'ipv6');
  assert.equal((await inspectSelectedPath({getStats: async () => new Map()})).code, 'pair-unavailable');
});

test('host/prflx remains denied by default; narrow explicit exception preserves address safety', () => {
  assert.equal(pair('192.168.31.125', null, 'host', 'prflx').allowed, false);
  assert.equal(pair('192.168.31.125', null, 'host', 'prflx').code, 'prflx-unverified');
  const eligible = { allowPeerReflexive: true };
  const assess = (a, b, ta = 'host', tb = 'prflx') => assessPair(
    {candidateType: ta, address: a}, {candidateType: tb, address: b}, eligible);
  const masked = assess('192.168.31.125', '');
  assert.equal(masked.allowed, true);
  assert.equal(masked.code, 'masked-host-prflx-p2p');
  assert.equal(masked.remoteCandidateType, 'prflx');
  assert.equal(assess('192.168.31.125', 'phone.local').allowed, true);
  assert.equal(assess('192.168.31.125', '0.0.0.0').allowed, true);
  assert.equal(assess('192.168.31.125', '192.168.31.46').code, 'private-ipv4-host-prflx-pair');
  assert.equal(assess('192.168.31.125', '192.168.30.46').code, 'subnet-mismatch');
  assert.equal(assess('192.168.31.125', '192.168.31.125').code, 'same-address');
  assert.equal(assess('192.168.31.125', '8.8.8.8').allowed, false);
  assert.equal(assess('192.168.31.125', '2001:db8::1').allowed, false);
  assert.equal(assess('', '').allowed, false, 'a masked local address is not enough to approve prflx');
  assert.equal(assess('test.local', '192.168.31.46').allowed, false);
  assert.equal(assess('8.8.8.8', '').allowed, false);
  assert.equal(assess('192.168.31.125', '', 'host', 'srflx').allowed, false);
  assert.equal(assess('192.168.31.125', '', 'host', 'relay').allowed, false);
  assert.equal(assess('192.168.31.125', '', 'prflx', 'host').allowed, false);
  assert.equal(assess('192.168.31.125', '', 'relay', 'host').allowed, false);
});

test('selected host/prflx requires succeeded nominated ICE, open channel, connected transport and remote ready', async () => {
  const stats = new Map([
    ['t', {type:'transport', selectedCandidatePairId:'p'}],
    ['p', {type:'candidate-pair',state:'succeeded',nominated:true,localCandidateId:'a',remoteCandidateId:'b'}],
    ['a', {type:'local-candidate',candidateType:'host',address:'192.168.31.125'}],
    ['b', {type:'remote-candidate',candidateType:'prflx',address:''}],
  ]);
  const pc = {getStats:async()=>stats,connectionState:'connected',iceConnectionState:'connected'};
  const ready = {channelOpen:true,remoteReady:true};
  assert.equal((await inspectSelectedPath(pc, ready)).code, 'masked-host-prflx-p2p');
  assert.equal((await inspectSelectedPath(pc, {channelOpen:true,remoteReady:false})).allowed, false);
  assert.equal((await inspectSelectedPath(pc, {channelOpen:false,remoteReady:true})).allowed, false);
  assert.equal((await inspectSelectedPath(pc)).allowed, false);
  for (const connectionState of ['new','connecting','failed','disconnected']) {
    pc.connectionState = connectionState;
    assert.equal((await inspectSelectedPath(pc, ready)).allowed,false);
  }
  pc.connectionState = 'connected';
  for (const iceConnectionState of ['new','checking','failed','disconnected']) {
    pc.iceConnectionState = iceConnectionState;
    assert.equal((await inspectSelectedPath(pc, ready)).allowed,false);
  }
  pc.iceConnectionState = 'completed';
  assert.equal((await inspectSelectedPath(pc, ready)).allowed,true);
  pc.iceConnectionState = 'connected';
  stats.get('p').nominated = false;
  assert.equal((await inspectSelectedPath(pc, ready)).allowed,false);
  stats.get('p').nominated = true;
  stats.get('p').state = 'in-progress';
  assert.equal((await inspectSelectedPath(pc, ready)).allowed,false);
  stats.get('p').state = 'succeeded';
  stats.get('b').candidateType = 'relay';
  assert.equal((await inspectSelectedPath(pc, ready)).allowed,false);
  stats.get('b').candidateType = 'srflx';
  assert.equal((await inspectSelectedPath(pc, ready)).allowed,false);
  stats.get('b').candidateType = 'prflx';
  stats.get('b').address = '203.0.113.2';
  assert.equal((await inspectSelectedPath(pc, ready)).allowed,false);
  stats.get('b').address = '';
  stats.get('a').address = '';
  assert.equal((await inspectSelectedPath(pc, ready)).allowed,false);
});

test('ordinary host/host approval is not made dependent on reciprocal ready', async () => {
  const stats = new Map([
    ['t', {type:'transport',selectedCandidatePairId:'p'}],
    ['p', {type:'candidate-pair',state:'succeeded',localCandidateId:'a',remoteCandidateId:'b'}],
    ['a', {type:'local-candidate',candidateType:'host',address:'192.168.31.125'}],
    ['b', {type:'remote-candidate',candidateType:'host',address:'192.168.31.46'}],
  ]);
  const pc = {getStats:async()=>stats,connectionState:'new',iceConnectionState:'new'};
  const verdict = await inspectSelectedPath(pc);
  assert.equal(verdict.allowed,true);
  assert.equal(verdict.code,'private-ipv4-host-pair');
});
