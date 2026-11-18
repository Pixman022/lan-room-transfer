import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { isHostCandidateLine } from '../public/route-policy.js';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .split('\n').filter(line => !line.startsWith('import ')).join('\n');

// Exercise the real room controller against DOM/WebSocket stubs, without network access.
function harness({debug = false} = {}) {
  const debugMessages = [];
  const testConsole = {
    log: (...args) => debugMessages.push(args),
    error: (...args) => console.error(...args),
    warn: (...args) => console.warn(...args),
  };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: id === 'room-screen' || id === 'diagnostics-panel',
        textContent: '', value: '', className: '', dataset: {}, style: {},
        classList: { add() {}, remove() {} },
        append() {}, replaceChildren() {}, addEventListener() {},
        setAttribute() {}, focus() {}, select() {},
      });
    }
    return elements.get(id);
  };
  const timers = new Map();
  let nextTimer = 0;
  const storage = new Map();
  const sessionStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static sockets = [];
    constructor() {
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.sockets.push(this);
    }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    open() { this.readyState = 1; this.emit('open'); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  class FakeRTCPeerConnection {
    static instances = [];
    constructor() {
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.iceGatheringState = 'new';
      this.signalingState = 'stable';
      this.localDescription = null;
      this.remoteDescription = null;
      this.candidates = [];
      FakeRTCPeerConnection.instances.push(this);
    }
    createDataChannel() { return {readyState:'connecting',bufferedAmount:0,send(){}}; }
    async createOffer() { return {type:'offer', sdp:'offer-sdp'}; }
    async createAnswer() { return {type:'answer', sdp:'answer-sdp'}; }
    async setLocalDescription(value) {
      this.localDescription = value;
      this.signalingState = value.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(value) {
      this.remoteDescription = value;
      this.signalingState = 'stable';
    }
    async addIceCandidate(candidate) { this.candidates.push(candidate); }
    close() { this.connectionState = 'closed'; this.signalingState='closed'; }
  }
  const context = vm.createContext({
    window: { localStorage: sessionStorage, addEventListener() {} },
    document: {
      getElementById: element,
      createElement: tag => element(Symbol(tag)),
      createTextNode: value => ({textContent: value}),
    },
    sessionStorage,
    location: {
      protocol: 'https:', host: 'test.example',
      search: debug ? '?debug=1' : '',
      href: debug ? 'https://test.example/?debug=1' : 'https://test.example/',
    },
    WebSocket: FakeWebSocket,
    RTCPeerConnection: FakeRTCPeerConnection,
    isHostCandidateLine,
    setTimeout: (cb, ms) => { const id = ++nextTimer; timers.set(id, {cb, ms}); return id; },
    clearTimeout: id => timers.delete(id),
    queueMicrotask,
    fetch: async () => { throw Error('no test network'); },
    navigator: {userAgent: 'TestBrowser'}, crypto: {randomUUID: () => 'test-uuid'},
    Blob, Map, Set, Date, Promise, console: testConsole,
    DEVICE_NAME_KEY: 'device-key',
    getOrCreateDeviceName: () => 'Amber Fox',
    generateDeviceName: () => 'Amber Fox',
    deviceAvatar: () => '🦊',
    normalizeRoomCode: code => code,
    generateRandomRoomCode: () => '5832',
  });
  vm.runInContext(appSource, context, {filename:'app.js'});
  const run = expression => vm.runInContext(expression, context);
  return {state: run('state'), run, timers, elements, FakeWebSocket, FakeRTCPeerConnection, debugMessages};
}
const join = async (t, socket, generation='gen-1') => {
  socket.open();
  await t.run('handleServer({type:"welcome",code:"5832",id:"local-id",token:"local-token",generation:"' + generation + '",name:"Amber Fox",peers:[]})');
};
const fireNextTimer = t => {
  const [id, timer] = t.timers.entries().next().value;
  t.timers.delete(id);
  timer.cb();
};

test('unexpected disconnect re-enters same room with identity and staged files', async () => {
  const t = harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const ws1 = t.FakeWebSocket.sockets[0];
  await join(t, ws1);
  t.state.ownOffers.push({offerId:'offer-1', files:[{id:'f1',name:'note.txt',size:4}]});
  const file = {size:4};
  t.state.outbound.set('offer-1', new Map([['f1',file]]));
  const queued = {name:'queued.txt',size:5,received:0,status:'排队中',chunks:[]};
  t.state.queue.push(queued);
  t.state.jobs.push(queued);
  ws1.close();

  assert.equal(t.state.ws,null);
  assert.equal(t.state.code,'5832');
  assert.equal(t.state.ownOffers.length,1);
  assert.equal(t.state.outbound.get('offer-1').get('f1'),file);
  assert.equal(t.state.queue.length,0);
  assert.match(queued.status,/失败/);
  assert.equal(t.elements.get('room-screen').hidden,false);
  assert.equal(t.elements.get('connection-status').textContent,'正在恢复连接');

  assert.equal([...t.timers.values()][0].ms,1000);
  fireNextTimer(t);
  assert.equal(t.FakeWebSocket.sockets.length,2);
  const ws2=t.FakeWebSocket.sockets[1];
  ws2.open();
  assert.equal(ws2.sent[0].code,'5832');
  assert.equal(ws2.sent[0].id,'local-id');
  assert.equal(ws2.sent[0].token,'local-token');
  await t.run('handleServer({type:"welcome",code:"5832",id:"local-id",token:"local-token",generation:"gen-2",name:"Amber Fox",peers:[]})');
  assert.equal(t.state.generation,'gen-2');
  assert.equal(t.state.ownOffers.length,1);
  assert.equal(t.state.outbound.get('offer-1').get('f1'),file);
  assert.equal(t.timers.size,0);
  ws2.close();
  assert.equal([...t.timers.values()][0].ms,1000,'successful welcome resets backoff');
});

test('failed reconnects back off and manual exit prevents retries', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const first=t.FakeWebSocket.sockets[0];
  await join(t, first);
  first.close();
  for (const delay of [1000,2000,4000,8000,15000,15000]) {
    const [job] = [...t.timers.values()];
    assert.equal(job?.ms,delay);
    fireNextTimer(t);
    t.FakeWebSocket.sockets.at(-1).close();
  }
  assert.equal(t.timers.size,1);
  t.run('document.getElementById("leave-room").onclick()');
  assert.equal(t.timers.size,0);
  assert.equal(t.state.code,'');
  assert.equal(t.state.leaving,true);
});

test('invalid initial room entry fails without reconnecting', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const ws=t.FakeWebSocket.sockets[0];
  ws.open();
  await t.run('handleServer({type:"error",message:"房间在线设备已达到上限"})');
  assert.equal(ws.readyState,t.FakeWebSocket.CLOSED);
  assert.equal(t.timers.size,0);
  assert.equal(t.state.code,'');
});

test('temporary room-entry rejection during recovery continues backoff', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const first=t.FakeWebSocket.sockets[0];
  await join(t,first);
  first.close();
  fireNextTimer(t);
  const retry=t.FakeWebSocket.sockets[1];
  retry.open();
  await t.run('handleServer({type:"error",message:"请求过于频繁，请稍后重试"})');
  assert.equal(retry.readyState,t.FakeWebSocket.CLOSED);
  assert.equal(t.state.code,'5832');
  assert.equal(t.timers.size,1);
  assert.equal([...t.timers.values()][0].ms,2000);
});

test('initial phone offerer yields to PC after ICE stalls, isolating old candidates', async () => {
  const t = harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  await t.run('createPeer("pc","Desktop",true,"gen-pc")');
  const first=t.state.peers.get('pc');
  assert.equal(first.attempt,1);
  assert.equal(first.initiator,true);
  assert.equal(socket.sent.at(-1).signal.type,'offer');

  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  const second=t.state.peers.get('pc');
  assert.equal(first.pc.connectionState,'closed');
  assert.equal(second.attempt,2);
  assert.equal(second.initiator,false);
  assert.equal(second.originalInitiator,true);
  assert.deepEqual(socket.sent.at(-1).signal,{type:'role-switch',attempt:1});

  await t.run('handleSignal("pc","gen-pc",{type:"answer",attempt:1,sdp:"stale"})');
  await t.run('handleSignal("pc","gen-pc",{type:"candidate",attempt:1,candidate:{candidate:"candidate:1 1 udp 1 192.168.1.2 7777 typ host"}})');
  assert.equal(second.pc.remoteDescription,null);
  assert.equal(second.pc.candidates.length,0);

  await t.run('handleSignal("pc","gen-pc",{type:"offer",attempt:2,sdp:"pc-offer"})');
  assert.equal(second.pc.remoteDescription.sdp,'pc-offer');
  assert.equal(second.stage,'answer-sent');
  assert.equal(socket.sent.at(-1).signal.type,'answer');
  assert.equal(socket.sent.at(-1).signal.attempt,2);
  await t.run('handleSignal("pc","gen-pc",{type:"candidate",attempt:2,candidate:{candidate:"candidate:1 1 udp 1 192.168.1.3 7778 typ host"}})');
  assert.equal(second.pc.candidates.length,1);

  fireNextTimer(t);
  assert.deepEqual(socket.sent.at(-1).signal,{type:'retry',attempt:2});
  await t.run('handleSignal("pc","gen-pc",{type:"offer",attempt:3,sdp:"pc-retry"})');
  assert.equal(t.state.peers.get('pc').attempt,3);
  assert.equal(t.state.peers.get('pc').initiator,false);
  fireNextTimer(t);
  assert.match(t.state.peers.get('pc').reason,/多次尝试未成功/);
});

test('initial PC answerer takes over the offerer role after ICE stalls', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  await t.run('handleServer({type:"peer-online",id:"phone",name:"Mobile",generation:"gen-phone"})');
  const peer0=t.state.peers.get('phone');
  assert.equal(peer0.attempt,0);
  assert.equal(peer0.initiator,false);
  await t.run('handleSignal("phone","gen-phone",{type:"offer",attempt:1,sdp:"phone-offer"})');
  const first=t.state.peers.get('phone');
  assert.equal(first.stage,'answer-sent');
  assert.equal(first.attempt,1);
  assert.equal(socket.sent.at(-1).signal.type,'answer');

  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  const second=t.state.peers.get('phone');
  assert.notEqual(second,first);
  assert.equal(first.pc.connectionState,'closed');
  assert.equal(second.initiator,true);
  assert.equal(second.originalInitiator,false);
  assert.equal(second.attempt,2);
  assert.deepEqual(socket.sent.at(-2).signal,{type:'role-switch',attempt:1});
  assert.equal(socket.sent.at(-1).signal.type,'offer');
  assert.equal(socket.sent.at(-1).signal.attempt,2);

  await t.run('handleSignal("phone","gen-phone",{type:"candidate",attempt:1,candidate:{candidate:"candidate:1 1 udp 1 192.168.1.2 4444 typ host"}})');
  assert.equal(second.pc.candidates.length,0);
  await t.run('handleSignal("phone","gen-phone",{type:"answer",attempt:2,sdp:"mobile-answer"})');
  assert.equal(second.pc.remoteDescription.sdp,'mobile-answer');
  await t.run('handleSignal("phone","gen-phone",{type:"candidate",attempt:2,candidate:{candidate:"candidate:1 1 udp 1 192.168.1.2 4444 typ host"}})');
  assert.equal(second.pc.candidates.length,1);
});

test('healthy open DataChannel is not replaced when connection timer fires', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');
  const peer=t.state.peers.get('other');
  const initialPackets=socket.sent.length;
  peer.channel.readyState='open';
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  fireNextTimer(t);
  assert.equal(t.state.peers.get('other'),peer);
  assert.equal(peer.pc.connectionState,'connected');
  assert.equal(socket.sent.length,initialPackets);
});

test('disconnected ICE transport schedules a bounded early retry', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');
  const original=t.state.peers.get('other');
  original.pc.connectionState='disconnected';
  original.pc.onconnectionstatechange();
  assert.equal([...t.timers.values()][0].ms,5000);
  fireNextTimer(t);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.state.peers.get('other').attempt,2);
  assert.equal(original.pc.connectionState,'closed');
});

test('disconnected RTC is rebuilt even when DataChannel still reports open', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');
  const peer=t.state.peers.get('other');
  peer.channel.readyState='open';
  peer.pc.connectionState='disconnected';
  peer.pc.onconnectionstatechange();
  assert.equal([...t.timers.values()][0].ms,5000);
  fireNextTimer(t);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.state.peers.get('other').attempt,2);
  assert.equal(peer.pc.connectionState,'closed');
});

test('full debug mode prints raw credentials, SDP, candidate addresses and file names', async () => {
  const t = harness({debug: true});
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket = t.FakeWebSocket.sockets[0];
  await join(t, socket);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');
  await t.run('handleSignal("other","gen-peer",{type:"answer",attempt:1,sdp:"v=0\\r\\nc=IN IP4 10.12.34.56\\r\\n"})');
  await t.run('handleSignal("other","gen-peer",{type:"candidate",attempt:1,candidate:{candidate:"candidate:1 1 udp 1 192.168.9.4 7777 typ host"}})');
  t.run('shareFiles([{name:"private-debug-file.txt",size:5,type:"text/plain",lastModified:42}])');
  const dump = JSON.stringify(t.debugMessages);
  assert.match(dump, /LAN Room debug/);
  assert.match(dump, /room.joined/);
  assert.match(dump, /local-token/);
  assert.match(dump, /5832/);
  assert.match(dump, /offer-sdp/);
  assert.ok(dump.includes('10.12.34.56'));
  assert.ok(dump.includes('192.168.9.4'));
  assert.ok(dump.includes('private-debug-file.txt'));
});

test('default mode does not log room credentials or raw SDP', async () => {
  const t = harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket = t.FakeWebSocket.sockets[0];
  await join(t, socket);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');
  assert.equal(t.debugMessages.length, 0);
});

test('role switch is idempotent when both phone and PC time out concurrently', async () => {
  const phone=harness();
  const pc=harness();
  for(const t of [phone,pc]){
    t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
    await join(t,t.FakeWebSocket.sockets[0]);
  }
  await phone.run('createPeer("pc","Desktop",true,"gen-pc")');
  await pc.run('createPeer("phone","Mobile",false,"gen-phone")');
  const originalPhone=phone.state.peers.get('pc');
  const originalPc=pc.state.peers.get('phone');

  // Let both independently hit the 15-second timer before either receives
  // the other side's role-switch notification.
  fireNextTimer(phone);
  fireNextTimer(pc);
  await new Promise(resolve=>setImmediate(resolve));
  const phone2=phone.state.peers.get('pc');
  const pc2=pc.state.peers.get('phone');
  assert.equal(phone2.initiator,false);
  assert.equal(pc2.initiator,true);
  assert.equal(phone2.attempt,2);
  assert.equal(pc2.attempt,2);
  assert.equal(originalPhone.pc.connectionState,'closed');
  assert.equal(originalPc.pc.connectionState,'closed');

  await phone.run('handleSignal("pc","gen-pc",{type:"role-switch",attempt:1})');
  await pc.run('handleSignal("phone","gen-phone",{type:"role-switch",attempt:1})');
  assert.equal(phone.state.peers.get('pc'),phone2);
  assert.equal(pc.state.peers.get('phone'),pc2);
  const offer=pc.FakeWebSocket.sockets[0].sent.at(-1).signal;
  assert.equal(offer.type,'offer');
  await phone.run('handleSignal("pc","gen-pc",{type:"offer",attempt:2,sdp:"pc-offer"})');
  const answer=phone.FakeWebSocket.sockets[0].sent.at(-1).signal;
  assert.equal(answer.type,'answer');
  assert.equal(answer.attempt,2);
  await pc.run('handleSignal("phone","gen-phone",{type:"answer",attempt:2,sdp:"phone-answer"})');
  assert.equal(pc2.pc.remoteDescription.sdp,'phone-answer');
  assert.equal(pc.FakeRTCPeerConnection.instances.length,2);
  assert.equal(phone.FakeRTCPeerConnection.instances.length,2);
});

test('role switch is refused once the first P2P connection is ready', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("phone","Mobile",false,"gen-phone")');
  const peer=t.state.peers.get('phone');
  peer.ready=true;
  await t.run('handleSignal("phone","gen-phone",{type:"role-switch",attempt:1})');
  assert.equal(t.state.peers.get('phone'),peer);
  assert.equal(peer.initiator,false);
});
