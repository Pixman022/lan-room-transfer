import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { isHostCandidateLine, inspectSelectedPath as inspectRealPath } from '../public/route-policy.js';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .split('\n').filter(line => !line.startsWith('import ')).join('\n');

// Exercise the real room controller against DOM/WebSocket stubs, without network access.
function harness({debug = false, realRoutePolicy = false} = {}) {
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
    inspectSelectedPath: realRoutePolicy ? inspectRealPath : async () => ({
      allowed: true, code: 'masked-host-p2p',
      reason: '已建立 host P2P 连接', localAddressKind: 'hidden',
      remoteAddressKind: 'private-ipv4',
      localCandidateType: 'host', remoteCandidateType: 'host',
    }),
    setTimeout: (cb, ms) => { const id = ++nextTimer; timers.set(id, {cb, ms}); return id; },
    clearTimeout: id => timers.delete(id),
    queueMicrotask,
    fetch: async () => { throw Error('no test network'); },
    navigator: {userAgent: 'TestBrowser'}, crypto: {randomUUID: () => 'test-uuid'},
    Blob, ArrayBuffer, Map, Set, Date, Promise, console: testConsole,
    URL: {createObjectURL: () => 'blob:test-file', revokeObjectURL() {}},
    sha256Hex: async () => 'a'.repeat(64),
    isSha256Hex: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    verifySha256: async (blob, hash) => blob.size === 5 && hash === 'a'.repeat(64),
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

test('file request acknowledges promptly then transfers a small file over the private channel', async () => {
  const sender=harness();
  const receiver=harness();
  sender.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  receiver.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(sender,sender.FakeWebSocket.sockets[0]);
  await join(receiver,receiver.FakeWebSocket.sockets[0]);

  await sender.run('createPeer("receiver","Phone",true,"generation-r",4)');
  await receiver.run('createPeer("sender","Desktop",false,"generation-s",4)');
  const a=sender.state.peers.get('receiver');
  const b=receiver.state.peers.get('sender');
  const inbound={
    label:'room-files',ordered:true,readyState:'open',bufferedAmount:0,send() {},
  };
  b.pc.ondatachannel({channel:inbound});
  a.channel.readyState='open';
  a.channel.bufferedAmount=0;
  a.ready=true; b.ready=true;
  a.verified=true; b.verified=true;
  a.pc.connectionState='connected'; b.pc.connectionState='connected';
  a.pc.iceConnectionState='connected'; b.pc.iceConnectionState='connected';
  const fromSender=[],fromReceiver=[];
  a.channel.send=data=>{
    fromSender.push(data);
    setImmediate(()=>inbound.onmessage({data}));
  };
  inbound.send=data=>{
    fromReceiver.push(data);
    setImmediate(()=>a.channel.onmessage({data}));
  };
  const file=new Blob(['hello'],{type:'text/plain'});
  sender.state.outbound.set('offer-1',new Map([['file-1',file]]));
  receiver.state.offers.set('sender:offer-1',{
    peerId:'sender',offerId:'offer-1',
    files:[{id:'file-1',name:'hello.txt',size:5,status:'pending'}],
  });
  receiver.run('acceptFile(state.offers.get("sender:offer-1"), state.offers.get("sender:offer-1").files[0])');
  for(let i=0;i<15 && receiver.state.jobs[0].status!=='校验通过，点击保存';i++)
    await new Promise(resolve=>setImmediate(resolve));

  assert.equal(receiver.state.jobs[0].status,'校验通过，点击保存');
  assert.equal(receiver.state.jobs[0].received,5);
  assert.equal(receiver.state.jobs[0].url,'blob:test-file');
  const sentKinds=fromSender.filter(x=>typeof x==='string').map(x=>JSON.parse(x).kind);
  assert.deepEqual(sentKinds,['file-request-ack','file-start','file-end']);
  assert.deepEqual(fromReceiver.filter(x=>typeof x==='string').map(x=>JSON.parse(x).kind),['request-file']);
  const sendDiag=sender.run('diagnosticsSnapshot().peers[0].transfer');
  const receiveDiag=receiver.run('diagnosticsSnapshot().peers[0].transfer');
  assert.equal(sendDiag.requestsReceived,1);
  assert.equal(sendDiag.acksSent,1);
  assert.equal(sendDiag.startsSent,1);
  assert.equal(receiveDiag.requestsSent,1);
  assert.equal(receiveDiag.acksReceived,1);
  assert.equal(receiveDiag.startsReceived,1);
  assert.equal(receiveDiag.errorsReceived,0);
  assert.ok(!JSON.stringify(receiveDiag).includes('hello.txt'),'ordinary counters never reveal filenames');
});

test('receiver distinguishes sender acknowledgement from file-start timeout', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("sender","Desktop",true,"gen-sender")');
  const peer=t.state.peers.get('sender');
  peer.ready=true; peer.channel.readyState='open';
  const sent=[];
  peer.channel.send=data=>sent.push(JSON.parse(data));
  t.state.offers.set('sender:offer-1',{
    peerId:'sender',offerId:'offer-1',
    files:[{id:'file-1',name:'hello.txt',size:5,status:'pending'}],
  });
  t.run('acceptFile(state.offers.get("sender:offer-1"), state.offers.get("sender:offer-1").files[0])');
  assert.equal(t.state.active.status,'等待发送端');
  assert.equal(t.timers.get(t.state.active.timer).ms,20000);
  assert.equal(sent[0].kind,'request-file');

  peer.channel.onmessage({data:JSON.stringify({kind:'file-request-ack',offerId:'offer-1',fileId:'file-1'})});
  assert.equal(t.state.active.status,'发送端已响应，等待文件启动');
  assert.equal(t.timers.get(t.state.active.timer).ms,20000);
  assert.equal(t.run('diagnosticsSnapshot().peers[0].transfer.acksReceived'),1);
  const timer=t.timers.get(t.state.active.timer);
  t.timers.delete(t.state.active.timer);
  timer.cb();
  assert.match(t.state.jobs[0].status,/发送端已响应，但未开始发送/);
});

test('failed control-channel send returns an immediate failure instead of waiting for a timeout', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("sender","Desktop",true,"gen-sender")');
  const peer=t.state.peers.get('sender');
  peer.ready=true; peer.channel.readyState='open';
  peer.channel.send=()=>{throw new Error('transport send failure');};
  t.state.offers.set('sender:offer-1',{
    peerId:'sender',offerId:'offer-1',
    files:[{id:'file-1',name:'hello.txt',size:5,status:'pending'}],
  });
  t.run('acceptFile(state.offers.get("sender:offer-1"), state.offers.get("sender:offer-1").files[0])');
  assert.match(t.state.jobs[0].status,/文件请求发送失败/);
  assert.equal(t.run('diagnosticsSnapshot().peers[0].transfer.sendErrors'),1);
});

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

test('two original-offerer failures reverse at attempt 3, with one final reversed retry', async () => {
  const t = harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket = t.FakeWebSocket.sockets[0];
  await join(t, socket);
  await t.run('createPeer("other", "Sky Deer", true, "gen-peer")');
  assert.equal(t.state.peers.get('other').attempt,1);
  assert.deepEqual(socket.sent.at(-1).signal,{type:'offer',attempt:1,sdp:'offer-sdp'});
  assert.equal([...t.timers.values()][0].ms,15000);

  fireNextTimer(t);
  await new Promise(resolve => setImmediate(resolve));
  const peer2=t.state.peers.get('other');
  assert.equal(peer2.attempt,2);
  assert.equal(peer2.initiator,true);
  assert.equal(t.FakeRTCPeerConnection.instances[0].connectionState,'closed');
  await t.run('handleSignal("other","gen-peer",{type:"answer",attempt:1,sdp:"stale"})');
  await t.run('handleSignal("other","gen-peer",{type:"candidate",attempt:1,candidate:{candidate:"candidate:1 1 udp 1 192.168.1.2 7777 typ host"}})');
  assert.equal(peer2.pc.remoteDescription,null);
  assert.equal(peer2.pc.candidates.length,0);
  await t.run('handleSignal("other","gen-peer",{type:"answer",attempt:2,sdp:"fresh"})');
  assert.equal(peer2.pc.remoteDescription.sdp,'fresh');
  // The old-style retry for attempt 2 must not create an incorrect offerer 3.
  await t.run('handleSignal("other","gen-peer",{type:"retry",attempt:2})');
  assert.equal(t.state.peers.get('other'),peer2);

  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  const reversed3=t.state.peers.get('other');
  assert.equal(reversed3.initiator,false,'original offerer swaps roles after two failures');
  assert.equal(reversed3.attempt,3);
  assert.equal(peer2.pc.connectionState,'closed');
  assert.deepEqual(socket.sent.at(-1).signal,{type:'retry',attempt:3});
  await t.run('handleSignal("other","gen-peer",{type:"candidate",attempt:2,candidate:{candidate:"candidate:1 1 udp 1 192.168.1.2 7777 typ host"}})');
  assert.equal(reversed3.pc.candidates.length,0,'stale candidates ignored after role swap');
  await t.run('handleSignal("other","gen-peer",{type:"offer",attempt:3,sdp:"reverse-offer"})');
  assert.equal(reversed3.stage,'answer-sent');

  // The reversed responder can request a retry of the reversed offerer.
  fireNextTimer(t);
  assert.deepEqual(socket.sent.at(-1).signal,{type:'retry',attempt:3});
  await t.run('handleSignal("other","gen-peer",{type:"offer",attempt:4,sdp:"reverse-retry-offer"})');
  const reversed4=t.state.peers.get('other');
  assert.notEqual(reversed4,reversed3);
  assert.equal(reversed4.initiator,false);
  assert.equal(reversed4.attempt,4);
  assert.equal(reversed3.pc.connectionState,'closed');
  assert.equal(reversed4.pc.remoteDescription.sdp,'reverse-retry-offer');
  assert.deepEqual(socket.sent.at(-1).signal,{type:'answer',attempt:4,sdp:'answer-sdp'});
  await t.run('handleSignal("other","gen-peer",{type:"candidate",attempt:3,candidate:{candidate:"candidate:1 1 udp 1 192.168.1.3 7778 typ host"}})');
  assert.equal(reversed4.pc.candidates.length,0,'stale reversed candidates ignored');

  const before=socket.sent.length;
  fireNextTimer(t);
  assert.equal(t.state.peers.get('other'),reversed4);
  assert.equal(socket.sent.length,before,'fourth attempt is the final bounded attempt');
  assert.match(reversed4.reason,/多次尝试未成功/);
});

test('responder requests a new offer after answer-sent hangs in ICE new', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  await t.run('handleServer({type:"peer-online",id:"other",name:"Sky Deer",generation:"gen-peer"})');
  const peer0=t.state.peers.get('other');
  assert.equal(peer0.attempt,0);
  await t.run('handleSignal("other","gen-peer",{type:"offer",attempt:1,sdp:"initial"})');
  const peer1=t.state.peers.get('other');
  assert.equal(peer1.stage,'answer-sent');
  assert.equal(peer1.attempt,1);
  assert.equal(peer1.pc.remoteDescription.sdp,'initial');
  assert.equal(socket.sent.at(-1).signal.attempt,1);

  fireNextTimer(t);
  const request=socket.sent.at(-1);
  assert.equal(request.signal.type,'retry');
  assert.equal(request.signal.attempt,1);
  assert.equal(t.state.peers.get('other'),peer1);

  await t.run('handleSignal("other","gen-peer",{type:"offer",attempt:2,sdp:"retry-offer"})');
  const peer2=t.state.peers.get('other');
  assert.notEqual(peer2,peer1);
  assert.equal(peer1.pc.connectionState,'closed');
  assert.equal(peer2.stage,'answer-sent');
  assert.equal(peer2.attempt,2);
  assert.equal(peer2.pc.remoteDescription.sdp,'retry-offer');
  await t.run('handleSignal("other","gen-peer",{type:"candidate",attempt:1,candidate:{candidate:"candidate:1 1 udp 1 192.168.1.2 4444 typ host"}})');
  assert.equal(peer2.pc.candidates.length,0);
  await t.run('handleSignal("other","gen-peer",{type:"candidate",attempt:2,candidate:{candidate:"candidate:1 1 udp 1 192.168.1.2 4444 typ host"}})');
  assert.equal(peer2.pc.candidates.length,1);
});

test('original answerer offers on attempt 3 and can retry that role once at attempt 4', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  await t.run('handleServer({type:"peer-online",id:"other",name:"Sky Deer",generation:"gen-peer"})');
  await t.run('handleSignal("other","gen-peer",{type:"offer",attempt:2,sdp:"old-offer"})');
  const original=t.state.peers.get('other');
  assert.equal(original.initiator,false);
  assert.equal(original.attempt,2);
  await t.run('handleSignal("other","gen-peer",{type:"retry",attempt:3})');
  const reversed3=t.state.peers.get('other');
  assert.equal(original.pc.connectionState,'closed');
  assert.equal(reversed3.initiator,true);
  assert.equal(reversed3.attempt,3);
  assert.deepEqual(socket.sent.at(-1).signal,{type:'offer',attempt:3,sdp:'offer-sdp'});
  await t.run('handleSignal("other","gen-peer",{type:"answer",attempt:2,sdp:"stale-answer"})');
  assert.equal(reversed3.pc.remoteDescription,null);
  await t.run('handleSignal("other","gen-peer",{type:"answer",attempt:3,sdp:"reverse-answer"})');
  assert.equal(reversed3.pc.remoteDescription.sdp,'reverse-answer');

  // A failed reversed offer retries in the same reversed direction, not a new role swap.
  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  const reversed4=t.state.peers.get('other');
  assert.equal(reversed3.pc.connectionState,'closed');
  assert.equal(reversed4.initiator,true);
  assert.equal(reversed4.attempt,4);
  assert.deepEqual(socket.sent.at(-1).signal,{type:'offer',attempt:4,sdp:'offer-sdp'});
  await t.run('handleSignal("other","gen-peer",{type:"answer",attempt:3,sdp:"stale-reverse-answer"})');
  assert.equal(reversed4.pc.remoteDescription,null);
  await t.run('handleSignal("other","gen-peer",{type:"answer",attempt:4,sdp:"new-reverse-answer"})');
  assert.equal(reversed4.pc.remoteDescription.sdp,'new-reverse-answer');
  const before=socket.sent.length;
  fireNextTimer(t);
  assert.equal(t.state.peers.get('other'),reversed4);
  assert.equal(socket.sent.length,before,'no retry after attempt 4');
});

test('healthy connected channel awaiting reciprocal ready never triggers reverse offer', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer",2)');
  const peer=t.state.peers.get('other');
  peer.channel.readyState='open';
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  const before=socket.sent.length;
  fireNextTimer(t);
  assert.equal(t.state.peers.get('other'),peer);
  assert.equal(socket.sent.length,before,'never swap when ICE transport is healthy');
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

test('debug copy report includes SDP, room credentials and live ICE pair check counters', async () => {
  const t=harness({debug:true});
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const ws=t.FakeWebSocket.sockets[0];
  await join(t,ws);
  await t.run('createPeer("phone","Phone",true,"gen-phone")');
  await t.run('handleSignal("phone","gen-phone",{type:"answer",attempt:1,sdp:"v=0\\r\\nc=IN IP4 10.12.34.56\\r\\n"})');
  await t.run('handleSignal("phone","gen-phone",{type:"candidate",attempt:1,candidate:{candidate:"candidate:1 1 udp 1 192.168.9.4 7777 typ host"}})');
  const peer=t.state.peers.get('phone');
  peer.pc.getStats=async()=>new Map([
    ['local-a',{type:'local-candidate',id:'local-a',candidateType:'host',address:'192.168.9.3',port:7000}],
    ['remote-a',{type:'remote-candidate',id:'remote-a',candidateType:'host',address:'192.168.9.4',port:7777}],
    ['pair-a',{type:'candidate-pair',id:'pair-a',localCandidateId:'local-a',remoteCandidateId:'remote-a',state:'in-progress',requestsSent:3,requestsReceived:0,responsesSent:0,responsesReceived:0}],
    ['transport-a',{type:'transport',id:'transport-a',selectedCandidatePairId:null}],
  ]);
  const report=await t.run('buildDiagnosticsReport()');
  assert.equal(report.fullDebug,true);
  assert.equal(report.room.code,'5832');
  assert.equal(report.room.token,'local-token');
  assert.equal(report.detailedPeers[0].acceptedCandidates,1);
  assert.equal(report.detailedPeers[0].rejectedCandidates,0);
  assert.equal(report.detailedPeers[0].iceSummary.candidatePairs[0].requestsSent,3);
  assert.equal(report.detailedPeers[0].iceSummary.candidatePairs[0].responsesReceived,0);
  assert.equal(report.detailedPeers[0].iceSummary.localCandidates[0].address,'192.168.9.3');
  assert.equal(report.detailedPeers[0].iceSummary.remoteCandidates[0].address,'192.168.9.4');
  assert.ok(JSON.stringify(report.events).includes('10.12.34.56'));
  assert.ok(JSON.stringify(report).includes('candidate:1 1 udp 1 192.168.9.4'));
});

test('ordinary copy diagnostics does not expose SDP, room token or ICE addresses', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const ws=t.FakeWebSocket.sockets[0];
  await join(t,ws);
  await t.run('createPeer("phone","Phone",true,"gen-phone")');
  const peer=t.state.peers.get('phone');
  peer.pc.getStats=async()=>new Map([
    ['local-a',{type:'local-candidate',id:'local-a',address:'192.168.9.3'}],
  ]);
  const report=await t.run('buildDiagnosticsReport()');
  const serialized=JSON.stringify(report);
  assert.equal(report.fullDebug,undefined);
  assert.equal(report.detailedPeers,undefined);
  assert.equal(report.events,undefined);
  assert.ok(!serialized.includes('local-token'));
  assert.ok(!serialized.includes('5832'));
  assert.ok(!serialized.includes('192.168.9.3'));
});

test('ordinary ICE diagnosis identifies suspected mDNS failure without exposing private data', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("phone","Phone",true,"gen-phone")');
  const peer=t.state.peers.get('phone');
  peer.acceptedCandidates=1;
  peer.remoteCandidateCount=1;
  peer.pc.iceConnectionState='failed';
  peer.pc.localDescription={
    type:'offer',sdp:'v=0\r\na=candidate:1 1 udp 123 local-secret.local 5222 typ host\r\n'
  };
  peer.pc.remoteDescription={
    type:'answer',sdp:'v=0\r\na=candidate:2 1 udp 123 remote-secret.local 6000 typ host\r\nc=IN IP4 10.1.2.3\r\n'
  };
  peer.pc.getStats=async()=>new Map([
    ['local',{type:'local-candidate',id:'local',candidateType:'host',address:'192.168.9.3'}],
    ['transport',{type:'transport',id:'transport'}],
  ]);
  const report=await t.run('buildDiagnosticsReport()');
  const diagnosis=report.peers[0].iceDiagnosis;
  assert.equal(diagnosis.code,'mdns-resolution-or-candidate-pair-suspected');
  assert.equal(diagnosis.remoteMdnsLines,1);
  assert.equal(diagnosis.candidatesAcceptedByApi,1);
  assert.equal(diagnosis.candidatePairsReported,0);
  const serialized=JSON.stringify(report);
  for(const sensitive of ['5832','local-token','Amber Fox','192.168.9.3','10.1.2.3','remote-secret.local','local-secret.local']) {
    assert.ok(!serialized.includes(sensitive), 'redacted report leaked: '+sensitive);
  }

  peer.pc.getStats=async()=>{throw Error('browser denied stats at 192.168.9.3');};
  const unavailable=await t.run('buildDiagnosticsReport()');
  assert.equal(unavailable.peers[0].iceDiagnosis.code,'stats-unavailable');
  assert.ok(!JSON.stringify(unavailable).includes('192.168.9.3'));
});

test('rejected remote ICE candidate is counted and propagated', async () => {
  const t=harness({debug:true});
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("phone","Phone",true,"gen-phone")');
  const peer=t.state.peers.get('phone');
  await t.run('handleSignal("phone","gen-phone",{type:"answer",attempt:1,sdp:"remote-answer"})');
  peer.pc.addIceCandidate=async()=>{throw new Error('candidate was rejected');};
  await assert.rejects(
    t.run('handleSignal("phone","gen-phone",{type:"candidate",attempt:1,candidate:{candidate:"candidate:1 1 udp 1 192.168.9.4 7777 typ host"}})'),
    /candidate was rejected/
  );
  const report=await t.run('buildDiagnosticsReport()');
  assert.equal(report.detailedPeers[0].acceptedCandidates,0);
  assert.equal(report.detailedPeers[0].rejectedCandidates,1);
  assert.ok(report.events.some(item=>item.event==='webrtc.addIceCandidate.failed'));
});

test('PC ICE new with accepted Firefox mDNS candidates but no pairs is classified as suspected, not proven', async () => {
  const h=harness({debug:true});
  h.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(h,h.FakeWebSocket.sockets[0]);
  await h.run('createPeer("phone","Phone",false,"gen-phone")');
  const p=h.state.peers.get('phone');
  p.attempt=3;
  p.acceptedCandidates=2;
  p.rejectedCandidates=0;
  p.remoteCandidateCount=2;
  p.pc.iceConnectionState='new';
  p.pc.localDescription={
    type:'answer',
    sdp:'v=0\r\na=candidate:1 1 udp 123 9a88.local 63559 typ host\r\n'
  };
  p.pc.remoteDescription={
    type:'offer',
    sdp:'v=0\r\na=candidate:0 1 udp 111 abc123.local 60326 typ host\r\na=candidate:1 1 tcp 100 abc123.local 9 typ host tcptype active\r\n'
  };
  p.pc.getStats=async()=>new Map([
    ['lc',{type:'local-candidate',id:'lc',candidateType:'host',port:63559}],
    ['transport',{type:'transport',id:'transport',iceState:'new',packetsSent:0,packetsReceived:0}],
  ]);
  const report=await h.run('buildDiagnosticsReport()');
  const d=report.detailedPeers[0].iceDiagnosis;
  assert.equal(d.code,'mdns-resolution-or-candidate-pair-suspected');
  assert.equal(d.remoteMdnsLines,2);
  assert.equal(d.localMdnsLines,1);
  assert.equal(d.candidatesAcceptedByApi,2);
  assert.equal(d.remoteCandidateStatsReported,0);
  assert.equal(d.candidatePairsReported,0);
  assert.ok(d.caveat.includes('不保证'));
});

test('reported ICE checks without responses are distinguished from absent pairs', () => {
  const h=harness({debug:true});
  const pc={iceConnectionState:'checking',localDescription:{sdp:'v=0'},
    remoteDescription:{sdp:'v=0'}};
  const d=h.run('diagnoseIce({pc: '+JSON.stringify(pc)+',acceptedCandidates:1,remoteCandidateCount:1}, '+JSON.stringify([
    {type:'remote-candidate',id:'r'},
    {type:'candidate-pair',id:'pair',state:'in-progress',requestsSent:5,responsesReceived:0},
  ])+')');
  assert.equal(d.code,'checks-without-response');
  assert.equal(d.reportedCheckCounters.requestsSent,5);
  assert.equal(d.reportedCheckCounters.responsesReceived,0);
});

test('missing browser response counter does not imply unanswered checks', () => {
  const h=harness();
  const pc={iceConnectionState:'checking',localDescription:{sdp:'v=0'},
    remoteDescription:{sdp:'v=0'}};
  const d=h.run('diagnoseIce({pc: '+JSON.stringify(pc)+'}, '+JSON.stringify([
    {type:'candidate-pair',id:'pair',requestsSent:5,state:'in-progress'},
  ])+')');
  assert.equal(d.code,'candidate-pair-reported');
});

test('connected ICE is reported as connected even when stats omit candidate pairs', () => {
  const h=harness();
  const d=h.run('diagnoseIce({pc:{iceConnectionState:"connected",localDescription:null,remoteDescription:null}}, [])');
  assert.equal(d.code,'ice-connected');
});

test('connected DataChannel without reciprocal ready reports pending handshake, never renegotiates ICE', async () => {
  const t=harness({debug:true});
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const ws=t.FakeWebSocket.sockets[0];
  await join(t,ws);
  await t.run('createPeer("phone","Phone",false,"gen-phone")');
  const peer=t.state.peers.get('phone');
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  const channel={
    label:'room-files',ordered:true,readyState:'open',sent:[],
    send(data){this.sent.push(JSON.parse(data));},
  };
  peer.pc.ondatachannel({channel});
  await channel.onopen();
  assert.equal(peer.verified,true);
  assert.equal(peer.localReadySent,true);
  assert.equal(peer.remoteReady,false);
  assert.equal(peer.ready,false);
  assert.deepEqual(channel.sent,[{kind:'ready'}]);
  assert.match(peer.reason,/等待对端/);
  assert.equal(t.run('diagnosticsSnapshot().peers[0].localReadySent'),true);
  assert.equal(t.run('diagnosticsSnapshot().peers[0].canTransfer'),false);

  const oldCount=t.FakeRTCPeerConnection.instances.length;
  const signalingSent=ws.sent.length;
  fireNextTimer(t);
  assert.match(peer.reason,/尚未收到对端/);
  assert.equal(t.state.peers.get('phone'),peer);
  assert.equal(t.FakeRTCPeerConnection.instances.length,oldCount);
  assert.equal(ws.sent.length,signalingSent);
  assert.ok(t.debugMessages.some(args=>String(args[0]).includes('datachannel.ready.timeout')));

  const report=await t.run('buildDiagnosticsReport()');
  assert.equal(report.detailedPeers[0].handshake.localPathVerified,true);
  assert.equal(report.detailedPeers[0].handshake.localReadySent,true);
  assert.equal(report.detailedPeers[0].handshake.remoteReadyReceived,false);

  channel.onmessage({data:JSON.stringify({kind:'ready'})});
  assert.equal(peer.remoteReady,true);
  assert.equal(peer.ready,true);
  assert.equal(peer.reason,'文件直连就绪');
  assert.equal(t.run('diagnosticsSnapshot().peers[0].canTransfer'),true);
});

test('early remote ready is accepted after local path verification and local ready send', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("phone","Phone",false,"gen-phone")');
  const peer=t.state.peers.get('phone');
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  const channel={
    label:'room-files',ordered:true,readyState:'open',sent:[],
    send(data){this.sent.push(JSON.parse(data));},
  };
  peer.pc.ondatachannel({channel});
  channel.onmessage({data:JSON.stringify({kind:'ready'})});
  assert.equal(peer.remoteReady,true);
  assert.equal(peer.ready,false);
  await channel.onopen();
  assert.equal(peer.localReadySent,true);
  assert.equal(peer.ready,true);
  assert.equal(t.timers.size,0);
  assert.deepEqual(channel.sent,[{kind:'ready'}]);
});

test('phone selected host/prflx is gated until PC ready then completes reciprocal handshake', async () => {
  const t = harness({debug:true, realRoutePolicy:true});
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("pc","Desktop",true,"gen-pc")');
  const peer=t.state.peers.get('pc');
  const stats = new Map([
    ['transport',{type:'transport',selectedCandidatePairId:'pair',iceState:'connected',dtlsState:'connected'}],
    ['pair',{type:'candidate-pair',state:'succeeded',nominated:true,localCandidateId:'local',remoteCandidateId:'remote'}],
    ['local',{type:'local-candidate',candidateType:'host',address:'192.168.31.125'}],
    ['remote',{type:'remote-candidate',candidateType:'prflx',address:''}],
  ]);
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  peer.pc.getStats=async()=>stats;
  const channel=peer.channel;
  channel.readyState='open';
  channel.sent=[];
  channel.send=data=>channel.sent.push(JSON.parse(data));

  // App must not authorize the prflx exception before the other endpoint
  // signals that it has verified its own path.
  const pendingOpen=channel.onopen();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(peer.remoteReady,false);
  assert.equal(peer.verified,false);
  assert.equal(peer.localReadySent,false);
  assert.equal(peer.ready,false);
  assert.equal(channel.sent.length,0);

  channel.onmessage({data:JSON.stringify({kind:'ready'})});
  for (let n=0;n<8 && !peer.ready;n++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(peer.remoteReady,true);
  assert.equal(peer.verified,true);
  assert.equal(peer.localReadySent,true);
  assert.equal(peer.ready,true);
  assert.equal(peer.routeInfo.code,'masked-host-prflx-p2p');
  assert.deepEqual(channel.sent,[{kind:'ready'}]);
  assert.equal(t.run('diagnosticsSnapshot().peers[0].canTransfer'),true);
  assert.equal((await t.run('inspectPeerPath(state.peers.get("pc"))')).allowed,true,
    'transfer-time recheck must use same approved path policy');
  const report=await t.run('buildDiagnosticsReport()');
  assert.equal(report.detailedPeers[0].handshake.transferReady,true);
  // Resolve any outstanding onopen async verification in the stub if present.
  for(const [id,entry] of [...t.timers]) if(entry.ms===600){t.timers.delete(id); entry.cb();}
  await pendingOpen;
});

test('connected host/host sends a route-verified ready attestation without candidate addresses', async () => {
  const t=harness({realRoutePolicy:true});
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("phone","Phone",true,"gen-phone")');
  const peer=t.state.peers.get('phone');
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  peer.pc.getStats=async()=>new Map([
    ['t',{type:'transport',selectedCandidatePairId:'p'}],
    ['p',{type:'candidate-pair',state:'succeeded',nominated:true,localCandidateId:'l',remoteCandidateId:'r'}],
    ['l',{type:'local-candidate',candidateType:'host',address:'desktop.local'}],
    ['r',{type:'remote-candidate',candidateType:'host',address:'phone.local'}],
  ]);
  const channel=peer.channel;
  channel.readyState='open';
  channel.sent=[];
  channel.send=data=>channel.sent.push(JSON.parse(data));
  await channel.onopen();
  assert.equal(peer.localReadySent,true);
  assert.equal(peer.verified,true);
  assert.equal(peer.remoteReady,false);
  assert.deepEqual(channel.sent,[{kind:'ready',hostHostVerified:true}]);
  assert.ok(!JSON.stringify(channel.sent).includes('desktop.local'));
});

test('fully masked host/prflx stays blocked for legacy ready, then unlocks after host/host attestation', async () => {
  const t=harness({realRoutePolicy:true});
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("pc","Desktop",true,"gen-pc")');
  const peer=t.state.peers.get('pc');
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  const stats=new Map([
    ['t',{type:'transport',selectedCandidatePairId:'p'}],
    ['p',{type:'candidate-pair',state:'succeeded',nominated:true,localCandidateId:'l',remoteCandidateId:'r'}],
    ['l',{type:'local-candidate',candidateType:'host',address:''}],
    ['r',{type:'remote-candidate',candidateType:'prflx',address:''}],
  ]);
  peer.pc.getStats=async()=>stats;
  const channel=peer.channel;
  channel.readyState='open';
  channel.sent=[];
  channel.send=data=>channel.sent.push(JSON.parse(data));
  const openPromise=channel.onopen();
  await Promise.resolve();
  assert.equal(peer.verified,false);
  assert.equal(channel.sent.length,0);
  channel.onmessage({data:JSON.stringify({kind:'ready'})});
  for(let n=0;n<5;n++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(peer.remoteReady,true);
  assert.equal(peer.remoteHostPairVerified,false);
  assert.equal(peer.verified,false,'a legacy ready is not proof of host/host');
  assert.equal(channel.sent.length,0);
  channel.onmessage({data:JSON.stringify({kind:'ready',hostHostVerified:true})});
  for(let n=0;n<10 && !peer.ready;n++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(peer.remoteHostPairVerified,true);
  assert.equal(peer.verified,true);
  assert.equal(peer.localReadySent,true);
  assert.equal(peer.ready,true);
  assert.equal(peer.routeInfo.code,'masked-host-prflx-reciprocal-p2p');
  assert.deepEqual(channel.sent,[{kind:'ready'}]);
  assert.equal(t.run('diagnosticsSnapshot().peers[0].remoteHostPairVerified'),true);
  assert.equal((await t.run('inspectPeerPath(state.peers.get("pc"))')).allowed,true);
  stats.get('r').candidateType='relay';
  assert.equal((await t.run('inspectPeerPath(state.peers.get("pc"))')).allowed,false);
  stats.get('r').candidateType='prflx';
  stats.get('r').address='8.8.8.8';
  assert.equal((await t.run('inspectPeerPath(state.peers.get("pc"))')).allowed,false);
  for(const [id,entry] of [...t.timers]) if(entry.ms===600){t.timers.delete(id);entry.cb();}
  await openPromise;
});

test('file-time path rechecks still reject switched-to-relay or public prflx paths', async () => {
  const t=harness({realRoutePolicy:true});
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("pc","Desktop",true,"gen-pc")');
  const peer=t.state.peers.get('pc');
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  peer.channel.readyState='open';
  peer.remoteReady=true;
  const stats = new Map([
    ['t',{type:'transport',selectedCandidatePairId:'p'}],
    ['p',{type:'candidate-pair',state:'succeeded',nominated:true,localCandidateId:'l',remoteCandidateId:'r'}],
    ['l',{type:'local-candidate',candidateType:'host',address:'192.168.31.125'}],
    ['r',{type:'remote-candidate',candidateType:'prflx',address:''}],
  ]);
  peer.pc.getStats=async()=>stats;
  assert.equal((await t.run('inspectPeerPath(state.peers.get("pc"))')).allowed,true);
  stats.get('r').candidateType='relay';
  assert.equal((await t.run('inspectPeerPath(state.peers.get("pc"))')).allowed,false);
  stats.get('r').candidateType='srflx';
  assert.equal((await t.run('inspectPeerPath(state.peers.get("pc"))')).allowed,false);
  stats.get('r').candidateType='prflx';
  stats.get('r').address='8.8.8.8';
  assert.equal((await t.run('inspectPeerPath(state.peers.get("pc"))')).allowed,false);
  stats.get('r').address='192.168.32.5';
  assert.equal((await t.run('inspectPeerPath(state.peers.get("pc"))')).allowed,false);
});
