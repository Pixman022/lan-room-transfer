import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { isHostCandidateLine, inspectSelectedPath as inspectRealPath } from '../public/route-policy.js';
import { sha256Hex as realSha256Hex, isSha256Hex as realIsSha256Hex, verifySha256 as realVerifySha256 } from '../public/checksum.js';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .split('\n').filter(line => !line.startsWith('import ')).join('\n');

// Exercise the real room controller against DOM/WebSocket stubs, without network access.
function harness({debug = false, realRoutePolicy = false, realChecksum = false} = {}) {
  const debugMessages = [];
  const savedBlobs = [];
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
  const intervals = new Map();
  let nextIntervalId = 0;
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
    setInterval: (cb, ms) => { const id=++nextIntervalId; intervals.set(id,{cb,ms}); return id; },
    clearInterval: id => intervals.delete(id),
    queueMicrotask,
    fetch: async () => { throw Error('no test network'); },
    navigator: {userAgent: 'TestBrowser'}, crypto: {randomUUID: () => 'test-uuid'},
    Blob, ArrayBuffer, Map, Set, Date, Promise, console: testConsole,
    URL: {createObjectURL: blob => { savedBlobs.push(blob); return 'blob:test-file'; }, revokeObjectURL() {}},
    sha256Hex: realChecksum ? realSha256Hex : async () => 'a'.repeat(64),
    isSha256Hex: realChecksum ? realIsSha256Hex : value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    verifySha256: realChecksum ? realVerifySha256 : async (blob, hash) => blob.size === 5 && hash === 'a'.repeat(64),
    DEVICE_NAME_KEY: 'device-key',
    getOrCreateDeviceName: () => 'Amber Fox',
    generateDeviceName: () => 'Amber Fox',
    deviceAvatar: () => '🦊',
    normalizeRoomCode: code => code,
    generateRandomRoomCode: () => '5832',
  });
  vm.runInContext(appSource, context, {filename:'app.js'});
  const run = expression => vm.runInContext(expression, context);
  return {state: run('state'), run, timers, intervals, elements, FakeWebSocket, FakeRTCPeerConnection, debugMessages, savedBlobs};
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

// Link two VM peers through an ordered fake DataChannel. No network, but the
// actual application controller and WebCrypto checksum code run unmodified.
async function linkedFilePeers({tamperBinary = () => false, realRoutePolicy = false} = {}) {
  const sender=harness({realChecksum:true,realRoutePolicy});
  const receiver=harness({realChecksum:true,realRoutePolicy});
  for (const t of [sender,receiver]) {
    t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
    await join(t,t.FakeWebSocket.sockets[0]);
  }
  await sender.run('createPeer("receiver","Phone",true,"receiver-generation",3)');
  await receiver.run('createPeer("sender","Desktop",false,"sender-generation",3)');
  const a=sender.state.peers.get('receiver');
  const b=receiver.state.peers.get('sender');
  const receiverChannel={label:'room-files',ordered:true,readyState:'open',bufferedAmount:0,send(){}};
  b.pc.ondatachannel({channel:receiverChannel});
  a.channel.readyState='open';
  a.channel.bufferedAmount=0;
  a.ready=true; b.ready=true;
  a.remoteReady=true; b.remoteReady=true;
  a.verified=true; b.verified=true;
  a.pc.connectionState='connected'; b.pc.connectionState='connected';
  a.pc.iceConnectionState='connected'; b.pc.iceConnectionState='connected';
  const senderMessages=[],receiverMessages=[];
  a.channel.send=data=>{
    senderMessages.push(data);
    const transferred=tamperBinary(data) ? new Uint8Array(data.byteLength).fill(88).buffer : data;
    setImmediate(()=>receiverChannel.onmessage({data:transferred}));
  };
  receiverChannel.send=data=>{
    receiverMessages.push(data);
    setImmediate(()=>a.channel.onmessage({data}));
  };
  return {sender,receiver,a,b,senderMessages,receiverMessages};
}
async function flushUntil(predicate, maxMs=2000) {
  const deadline=Date.now()+maxMs;
  while(Date.now()<deadline){
    if(predicate())return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail('file-transfer condition was not reached within the test deadline');
}

test('shared catalog missed before reciprocal P2P ready is replayed after receiver verification', async () => {
  const t=await linkedFilePeers();
  const source=new Blob(['catalog should arrive after security verification']);
  t.sender.state.outbound.set('offer-early',new Map([['f1',source]]));
  t.sender.state.ownOffers.push({offerId:'offer-early',files:[
    {id:'f1',name:'test.txt',size:source.size}
  ]});
  // The uploader considers this link P2P-ready before the receiving browser
  // has finished validating its own route, which can happen in real devices.
  t.b.ready=false;
  t.b.verified=false;
  t.b.remoteReady=false;
  t.sender.run('syncSharedOffers(state.peers.get("receiver"))');
  await flushUntil(()=>t.senderMessages.some(x=>typeof x==='string' &&
    JSON.parse(x).kind==='file-list'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(t.receiver.state.offers.size,0,'unverified receiver must not expose the catalog');
  assert.ok(t.a.syncedOffers.has('offer-early'),'sender already considers catalog delivered');
  assert.equal(t.receiver.run('diagnosticsSnapshot().peers[0].transfer.catalogsIgnoredBeforeReady'),1);
  assert.equal(t.sender.run('diagnosticsSnapshot().localSharedFiles'),1);
  assert.equal(t.receiver.run('diagnosticsSnapshot().visibleRemoteFiles'),0);

  await t.receiver.run('receiveChannel(state.peers.get("sender"),JSON.stringify({kind:"ready",hostHostVerified:true}))');
  await flushUntil(()=>t.b.ready===true);
  await flushUntil(()=>t.receiver.state.offers.has('sender:offer-early'));
  assert.equal(t.receiver.state.offers.get('sender:offer-early').files[0].name,'test.txt');
  assert.equal(t.receiver.state.offers.size,1,'replay must not create duplicate offers');
  assert.equal(t.receiver.run('diagnosticsSnapshot().visibleRemoteFiles'),1);
  assert.equal(t.receiver.run('diagnosticsSnapshot().peers[0].transfer.catalogRequestsSent'),1);
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.catalogRequestsReceived'),1);
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.catalogsSent'),2);
  assert.equal(t.receiver.run('diagnosticsSnapshot().peers[0].transfer.catalogsReceived'),2);
  await t.sender.run('receiveChannel(state.peers.get("receiver"),JSON.stringify({kind:"file-list-request"}))');
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.catalogsSent'),2,
    'repeated catalog requests do not amplify file metadata transfers');
  assert.ok(!JSON.stringify(t.receiver.run('diagnosticsSnapshot()')).includes('test.txt'),
    'ordinary catalog diagnostics never reveal the filename');
});

test('MULTI-03: dropped B catalog after transient A disconnect is recovered on a verified live path', async () => {
  const t=await linkedFilePeers();
  // Before the network transition, the receiver already spent its one-time
  // catalog request and the sender has already served it once.
  t.receiver.run('requestSharedOffers(state.peers.get("sender"))');
  await flushUntil(()=>t.a.catalogReplayDone === true && t.b.catalogRequested === true);
  const originalPeers=t.receiver.FakeRTCPeerConnection.instances.length;
  const originalOffers=t.receiver.FakeWebSocket.sockets[0].sent.filter(m=>m.signal?.type==='offer').length;
  t.b.pc.connectionState='disconnected';
  t.b.pc.onconnectionstatechange();
  assert.equal(t.b.ready,false);
  assert.equal(t.b.verified,true);
  assert.equal(t.b.remoteReady,true);

  const source=new Blob(['B uploaded after a temporary channel outage']);
  t.sender.state.outbound.set('offer-b-new',new Map([['b-file',source]]));
  t.sender.state.ownOffers.push({offerId:'offer-b-new',files:[
    {id:'b-file',name:'B_reply_1MiB.bin',size:source.size}
  ]});
  t.sender.run('syncSharedOffers(state.peers.get("receiver"))');
  await flushUntil(()=>t.receiver.run('diagnosticsSnapshot().peers[0].transfer.catalogsIgnoredBeforeReady')===1);
  assert.equal(t.receiver.run('diagnosticsSnapshot().visibleRemoteFiles'),0);
  assert.equal(t.a.syncedOffers.has('offer-b-new'),true,'sender believes late catalog was sent');

  t.b.pc.connectionState='connected';
  t.b.pc.onconnectionstatechange();
  await flushUntil(()=>t.b.ready && t.receiver.state.offers.has('sender:offer-b-new'));
  assert.equal(t.b.reason,'文件直连就绪');
  assert.equal(t.receiver.state.offers.size,1,'deduplicate catalogs after recovery');
  assert.equal(t.receiver.run('diagnosticsSnapshot().visibleRemoteFiles'),1);
  assert.equal(t.a.catalogReplayDone,true,'initial replay has already been used');
  assert.equal(t.receiver.run('diagnosticsSnapshot().peers[0].transfer.catalogRefreshRequestsSent'),1);
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.catalogRefreshRequestsReceived'),1);
  assert.equal(t.receiver.FakeRTCPeerConnection.instances.length,originalPeers,'do not renegotiate ICE');
  assert.equal(t.receiver.FakeWebSocket.sockets[0].sent.filter(m=>m.signal?.type==='offer').length,
    originalOffers,'no new SDP offers');

  const sentBefore=t.sender.run('diagnosticsSnapshot().peers[0].transfer.catalogsSent');
  await t.sender.run('receiveChannel(state.peers.get("receiver"),JSON.stringify({kind:"file-list-request",refreshSeq:1}))');
  await t.sender.run('receiveChannel(state.peers.get("receiver"),JSON.stringify({kind:"file-list-request"}))');
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.catalogsSent'),sentBefore,
    'duplicate refresh and legacy requests cannot amplify file catalogs');
  const offer=t.receiver.state.offers.get('sender:offer-b-new');
  t.receiver.run('acceptFile(state.offers.get("sender:offer-b-new"),state.offers.get("sender:offer-b-new").files[0])');
  await flushUntil(()=>t.receiver.state.jobs[0]?.status==='校验通过，点击保存');
  assert.equal(await realSha256Hex(t.receiver.savedBlobs[0]),await realSha256Hex(source));
});

test('MULTI-03: a P2P link returning to connected cannot restore file transport over an unsafe selected path', async () => {
  const t=await linkedFilePeers();
  t.receiver.run('requestSharedOffers(state.peers.get("sender"))');
  await flushUntil(()=>t.a.catalogReplayDone===true);
  const requestsBefore=t.receiver.run('diagnosticsSnapshot().peers[0].transfer.catalogRequestsSent');
  t.b.pc.connectionState='disconnected';
  t.b.pc.onconnectionstatechange();
  assert.equal(t.b.ready,false);
  t.receiver.run('inspectSelectedPath = async () => ({allowed:false,code:"relay",reason:"Unsafe selected relay path"})');
  t.b.pc.connectionState='connected';
  t.b.pc.onconnectionstatechange();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(t.b.ready,false,'a stale previous approval must never restore transfer');
  assert.equal(t.receiver.run('diagnosticsSnapshot().peers[0].transfer.catalogRequestsSent'),requestsBefore,
    'no refresh over a denied selected route');
  assert.equal(t.receiver.run('diagnosticsSnapshot().peers[0].transfer.catalogRefreshRequestsSent'),0);
  assert.notEqual(t.b.reason,'文件直连就绪');
});

test('receive queue transfers multiple batches serially with real SHA-256, including an empty file', async () => {
  const t=await linkedFilePeers();
  const big=new Blob([new Uint8Array(40001).fill(91)]);
  const empty=new Blob([]);
  const last=new Blob(['third file']);
  t.sender.state.outbound.set('offer-a',new Map([['f1',big],['f2',empty]]));
  t.sender.state.outbound.set('offer-b',new Map([['f3',last]]));
  const first={peerId:'sender',offerId:'offer-a',files:[
    {id:'f1',name:'large.bin',size:big.size,status:'pending'},
    {id:'f2',name:'empty.txt',size:0,status:'pending'}]};
  const second={peerId:'sender',offerId:'offer-b',files:[
    {id:'f3',name:'third.txt',size:last.size,status:'pending'}]};
  t.receiver.state.offers.set('sender:offer-a',first);
  t.receiver.state.offers.set('sender:offer-b',second);
  t.receiver.run('acceptFile(state.offers.get("sender:offer-a"), state.offers.get("sender:offer-a").files[0])');
  t.receiver.run('acceptFile(state.offers.get("sender:offer-a"), state.offers.get("sender:offer-a").files[1])');
  t.receiver.run('acceptFile(state.offers.get("sender:offer-b"), state.offers.get("sender:offer-b").files[0])');
  assert.equal(t.receiver.state.jobs.length,3);
  assert.equal(t.receiver.state.queue.length,2);
  await flushUntil(()=>t.receiver.state.jobs.every(x=>x.status==='校验通过，点击保存'));
  assert.equal(t.receiver.state.active,null);
  assert.equal(t.receiver.state.queue.length,0);
  assert.equal(t.receiver.savedBlobs.length,3);
  for(const [i,source] of [big,empty,last].entries())
    assert.equal(await realSha256Hex(t.receiver.savedBlobs[i]),await realSha256Hex(source));
  const sent=t.receiverMessages.filter(x=>typeof x==='string').map(x=>JSON.parse(x));
  assert.deepEqual(sent.map(x=>x.fileId),['f1','f2','f3']);
  const starts=t.senderMessages.filter(x=>typeof x==='string' && JSON.parse(x).kind==='file-start').map(x=>JSON.parse(x));
  assert.deepEqual(starts.map(x=>x.fileId),['f1','f2','f3']);
  assert.equal(t.receiver.run('diagnosticsSnapshot().peers[0].transfer.startsReceived'),3);
});

test('file shelf accepts a 33 MiB file, transfers it and verifies original SHA-256', async () => {
  const t=await linkedFilePeers();
  const source=new Blob([new Uint8Array(32*1024*1024+19).fill(83)]);
  // The selected-file object is a stub; the sender's outbound data is replaced
  // with the real Blob so WebCrypto and the actual chunk path run unmodified.
  t.sender.run(`shareFiles([{name:'large.bin',size:${source.size},type:'application/octet-stream'}])`);
  assert.equal(t.sender.state.ownOffers.length,1,'32 MiB must not be a hard sharing limit');
  const offer=t.sender.state.ownOffers[0];
  assert.equal(offer.files[0].size,source.size);
  t.sender.state.outbound.get(offer.offerId).set(offer.files[0].id,source);
  await flushUntil(()=>t.receiver.state.offers.has('sender:'+offer.offerId));
  const received=t.receiver.state.offers.get('sender:'+offer.offerId);
  assert.equal(received.files[0].size,source.size,'metadata above 32 MiB must be accepted');
  t.receiver.run('acceptFile(state.offers.values().next().value, state.offers.values().next().value.files[0])');
  await flushUntil(()=>t.receiver.state.jobs[0]?.status==='校验通过，点击保存',20000);
  assert.equal(t.receiver.savedBlobs[0].size,source.size);
  assert.equal(await realSha256Hex(t.receiver.savedBlobs[0]),await realSha256Hex(source));
});

test('three peers: concurrent independent receivers and a second uploader never mix files', async () => {
  const clients={};
  for(const id of ['A','B','C']){
    clients[id]=harness({realChecksum:true});
    clients[id].run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
    await join(clients[id],clients[id].FakeWebSocket.sockets[0]);
  }
  async function link(leftId,rightId){
    const left=clients[leftId],right=clients[rightId];
    await left.run(`createPeer("${rightId}","${rightId}",true,"gen-${rightId}",3)`);
    await right.run(`createPeer("${leftId}","${leftId}",false,"gen-${leftId}",3)`);
    const l=left.state.peers.get(rightId),r=right.state.peers.get(leftId);
    const receiverChannel={label:'room-files',ordered:true,readyState:'open',
      bufferedAmount:0,send(){}};
    r.pc.ondatachannel({channel:receiverChannel});
    l.channel.readyState='open';l.channel.bufferedAmount=0;
    for(const peer of [l,r]){
      peer.ready=true;peer.verified=true;peer.remoteReady=true;
      peer.pc.connectionState='connected';peer.pc.iceConnectionState='connected';
    }
    l.channel.send=data=>setImmediate(()=>receiverChannel.onmessage({data}));
    receiverChannel.send=data=>setImmediate(()=>l.channel.onmessage({data}));
  }
  await link('A','B');
  await link('A','C');
  await link('B','C');

  const filesA=new Map([
    ['a1',new Blob([new Uint8Array(1024*1024+257).fill(65)])],
    ['a2',new Blob([])],
    ['a3',new Blob(['only A offered this file'])],
  ]);
  const filesB=new Map([['b1',new Blob(['only B offered this file'])]]);
  const publish=(client,id,files)=>{
    client.state.outbound.set(id,files);
    client.state.ownOffers.push({offerId:id,files:[...files].map(([fileId,blob])=>({
      id:fileId,name:`${fileId}.txt`,size:blob.size,
    }))});
    client.run('for(const peer of state.peers.values()) syncSharedOffers(peer)');
  };
  publish(clients.A,'offer-a',filesA);
  publish(clients.B,'offer-b',filesB);
  await flushUntil(()=>clients.B.state.offers.has('A:offer-a') &&
    clients.C.state.offers.has('A:offer-a') &&
    clients.A.state.offers.has('B:offer-b') &&
    clients.C.state.offers.has('B:offer-b'));
  assert.equal(clients.C.state.offers.size,2,'C sees both independent uploaders');
  assert.deepEqual(Array.from(clients.C.state.offers.get('A:offer-a').files,x=>x.id),
    ['a1','a2','a3']);

  // Same A file sent simultaneously to B and C; B uploads to A at the same
  // time. Each receiver has its own active job and serial queue.
  clients.C.run('for(const file of state.offers.get("A:offer-a").files) acceptFile(state.offers.get("A:offer-a"),file)');
  clients.B.run('acceptFile(state.offers.get("A:offer-a"),state.offers.get("A:offer-a").files[0])');
  clients.A.run('acceptFile(state.offers.get("B:offer-b"),state.offers.get("B:offer-b").files[0])');
  assert.equal(clients.C.state.queue.length,2);
  assert.equal(clients.B.state.queue.length,0);
  assert.equal(clients.A.state.queue.length,0);
  await flushUntil(()=>clients.C.state.jobs.length===3 &&
    clients.C.state.jobs.every(x=>x.status==='校验通过，点击保存') &&
    clients.B.state.jobs[0]?.status==='校验通过，点击保存' &&
    clients.A.state.jobs[0]?.status==='校验通过，点击保存',5000);

  assert.equal(clients.A.savedBlobs.length,1);
  assert.equal(clients.B.savedBlobs.length,1);
  assert.equal(clients.C.savedBlobs.length,3);
  assert.equal(await realSha256Hex(clients.A.savedBlobs[0]),await realSha256Hex(filesB.get('b1')));
  assert.equal(await realSha256Hex(clients.B.savedBlobs[0]),await realSha256Hex(filesA.get('a1')));
  for(const [index,blob] of Array.from(filesA.values()).entries()){
    assert.equal(await realSha256Hex(clients.C.savedBlobs[index]),await realSha256Hex(blob));
  }
  assert.equal(clients.C.state.queue.length,0);
  for(const id of ['A','B','C'])assert.equal(clients[id].state.active,null);
  assert.equal(clients.A.state.peers.get('B').transferEvents['request-file:received'],1);
  assert.equal(clients.A.state.peers.get('C').transferEvents['request-file:received'],3);
  assert.equal(clients.B.state.peers.get('A').transferEvents['request-file:received'],1);
});

function goodPathStats(remoteType='host') {
  return new Map([
    ['transport',{type:'transport',selectedCandidatePairId:'pair'}],
    ['pair',{type:'candidate-pair',state:'succeeded',nominated:true,
      localCandidateId:'local',remoteCandidateId:'remote'}],
    ['local',{type:'local-candidate',candidateType:'host',address:'192.168.15.4'}],
    ['remote',{type:'remote-candidate',candidateType:remoteType,address:'192.168.15.5'}],
  ]);
}
function routeTimer(t) {
  const found=[...t.sender.timers.entries()].find(([, timer])=>timer.ms===250);
  assert.ok(found,'expected 250 ms fail-closed route recheck wait');
  const [id, timer]=found;
  t.sender.timers.delete(id);
  timer.cb();
}
function offerLargeFile(t) {
  const original=new Blob([new Uint8Array(16*16384+1024).fill(73)]);
  t.sender.state.outbound.set('offer-route',new Map([['big',original]]));
  t.receiver.state.offers.set('sender:offer-route',{
    peerId:'sender',offerId:'offer-route',
    files:[{id:'big',name:'big.bin',size:original.size,status:'pending'}],
  });
  t.receiver.run('acceptFile(state.offers.get("sender:offer-route"),state.offers.get("sender:offer-route").files[0])');
  return original;
}

test('a missing selected-pair getStats sample pauses file bytes, then recovers safely', async () => {
  const t=await linkedFilePeers({realRoutePolicy:true});
  let checks=0;
  t.a.pc.getStats=async()=>++checks===3?new Map():goodPathStats();
  const original=offerLargeFile(t);
  await flushUntil(()=>[...t.sender.timers.values()].some(x=>x.ms===250));
  assert.equal(t.senderMessages.filter(x=>x instanceof ArrayBuffer).length,16,
    'file bytes must pause at the failed checkpoint');
  // The linked fake DataChannel delivers events on the next event-loop turn.
  await flushUntil(()=>t.receiver.state.jobs[0].status==='传输中');
  routeTimer(t);
  await flushUntil(()=>t.receiver.state.jobs[0].status==='校验通过，点击保存');
  assert.equal(await realSha256Hex(t.receiver.savedBlobs[0]),await realSha256Hex(original));
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.pathRechecksRetried'),1);
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.pathRechecksRecovered'),1);
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.pathRechecksFailed'),0);
});

test('an unsafe selected candidate immediately stops transfer without retrying or sending more bytes', async () => {
  const t=await linkedFilePeers({realRoutePolicy:true});
  let checks=0;
  t.a.pc.getStats=async()=>++checks===3?goodPathStats('relay'):goodPathStats();
  offerLargeFile(t);
  await flushUntil(()=>t.receiver.state.jobs[0].status.includes('传输途中路径检查失败'));
  assert.match(t.receiver.state.jobs[0].status,/non-host/);
  assert.equal(t.senderMessages.filter(x=>x instanceof ArrayBuffer).length,16,
    'route denial must stop the remaining chunks');
  assert.equal(t.sender.timers.size,1,'no route-check retry timer on unsafe candidate');
  assert.equal(t.receiver.savedBlobs.length,0,'partial received file is never saved');
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.pathRechecksRetried'),0);
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.pathRechecksFailed'),1);
});

test('persistent absent ICE statistics fail closed after only two paused rechecks', async () => {
  const t=await linkedFilePeers({realRoutePolicy:true});
  let checks=0;
  t.a.pc.getStats=async()=>++checks>=3?new Map():goodPathStats();
  offerLargeFile(t);
  await flushUntil(()=>[...t.sender.timers.values()].some(x=>x.ms===250));
  assert.equal(t.senderMessages.filter(x=>x instanceof ArrayBuffer).length,16);
  routeTimer(t);
  await flushUntil(()=>[...t.sender.timers.values()].some(x=>x.ms===250));
  assert.equal(t.senderMessages.filter(x=>x instanceof ArrayBuffer).length,16);
  routeTimer(t);
  await flushUntil(()=>t.receiver.state.jobs[0].status.includes('传输途中路径检查失败'));
  assert.match(t.receiver.state.jobs[0].status,/pair-unavailable/);
  assert.equal(t.senderMessages.filter(x=>x instanceof ArrayBuffer).length,16);
  assert.equal(t.receiver.savedBlobs.length,0);
  const diag=t.sender.run('diagnosticsSnapshot().peers[0].transfer');
  assert.equal(diag.pathRechecksRetried,2);
  assert.equal(diag.pathRechecksRecovered,0);
  assert.equal(diag.pathRechecksFailed,1);
  assert.equal(diag.lastPathRecheckCode,'pair-unavailable');
});

function maskedReflexivePathStats() {
  const stats=goodPathStats('prflx');
  stats.get('local').address='';
  stats.get('remote').address='';
  delete stats.get('pair').nominated;
  return stats;
}

test('mid-transfer prflx recovery requests fresh host/host proof and resumes only after approval', async () => {
  const t=await linkedFilePeers({realRoutePolicy:true});
  let checks=0;
  t.a.pc.getStats=async()=>++checks<=2?goodPathStats():maskedReflexivePathStats();
  t.b.pc.getStats=async()=>{
    const stats=goodPathStats();
    stats.delete('transport');
    stats.get('pair').selected=true;
    delete stats.get('pair').nominated;
    return stats;
  };
  const original=offerLargeFile(t);
  await flushUntil(()=>t.senderMessages.some(x=>typeof x==='string' &&
    JSON.parse(x).kind==='route-proof-request'));
  assert.equal(t.senderMessages.filter(x=>x instanceof ArrayBuffer).length,16,
    'bytes must not continue over an unverified prflx path');
  await flushUntil(()=>t.a.remoteHostPairVerified===true);
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.pathProofRequestsSent'),1);
  assert.equal(t.receiver.run('diagnosticsSnapshot().peers[0].transfer.pathProofRepliesReceived'),0);
  routeTimer(t);
  await flushUntil(()=>t.sender.run('diagnosticsSnapshot().peers[0].transfer.pathRechecksRecovered')===1 ||
    [...t.sender.timers.values()].some(timer=>timer.ms===250));
  const check=t.sender.run('diagnosticsSnapshot().peers[0].transfer');
  assert.equal(check.pathRechecksRecovered,1,
    JSON.stringify({check,job:t.receiver.state.jobs[0].status,remoteHostPairVerified:t.a.remoteHostPairVerified}));
  await flushUntil(()=>t.receiver.state.jobs[0].status==='校验通过，点击保存' ||
    t.receiver.state.jobs[0].status.startsWith('失败'));
  assert.equal(t.receiver.state.jobs[0].status,'校验通过，点击保存',
    JSON.stringify(t.sender.run('diagnosticsSnapshot().peers[0].transfer')));
  assert.equal(await realSha256Hex(t.receiver.savedBlobs[0]),await realSha256Hex(original));
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.pathRechecksRecovered'),1);
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.lastPathRecheckCode'),'prflx-unverified');
  const evidence=t.sender.run('diagnosticsSnapshot().peers[0].transfer.lastPathRecheckEvidence');
  assert.equal(evidence.remoteHostPairVerified,false);
  assert.equal(evidence.nominated,'missing');
  assert.equal(evidence.selectedByTransport,true);
  assert.ok(!JSON.stringify(evidence).includes('192.168.'),'normal diagnosis contains no network addresses');
});

test('if peer cannot attest host/host, prflx rechecks fail closed with no extra file bytes', async () => {
  const t=await linkedFilePeers({realRoutePolicy:true});
  let checks=0;
  t.a.pc.getStats=async()=>++checks<=2?goodPathStats():maskedReflexivePathStats();
  t.b.pc.getStats=async()=>maskedReflexivePathStats();
  offerLargeFile(t);
  await flushUntil(()=>t.senderMessages.some(x=>typeof x==='string' &&
    JSON.parse(x).kind==='route-proof-request'));
  await flushUntil(()=>t.receiverMessages.some(x=>typeof x==='string' &&
    JSON.parse(x).kind==='route-proof'));
  assert.equal(t.a.remoteHostPairVerified,false);
  assert.equal(t.senderMessages.filter(x=>x instanceof ArrayBuffer).length,16);
  routeTimer(t);
  await flushUntil(()=>[...t.sender.timers.values()].some(x=>x.ms===250));
  routeTimer(t);
  await flushUntil(()=>t.receiver.state.jobs[0].status.includes('传输途中路径检查失败'));
  assert.match(t.receiver.state.jobs[0].status,/prflx-unverified/);
  assert.equal(t.senderMessages.filter(x=>x instanceof ArrayBuffer).length,16);
  assert.equal(t.receiver.savedBlobs.length,0);
  const diag=t.sender.run('diagnosticsSnapshot().peers[0].transfer');
  assert.equal(diag.pathRechecksRetried,2);
  assert.equal(diag.pathRechecksFailed,1);
  assert.equal(diag.pathProofRequestsSent,1);
  assert.equal(diag.pathProofRepliesReceived,1);
});

test('cancel active file waits for the sender acknowledgement before starting the next queued file', async () => {
  const t=await linkedFilePeers();
  let releaseSlice;
  const blocked={size:5,slice(){return {arrayBuffer:()=>new Promise(resolve=>{releaseSlice=resolve;})};}};
  const next=new Blob(['world']);
  t.sender.state.outbound.set('offer-a',new Map([['f1',blocked],['f2',next]]));
  t.receiver.state.offers.set('sender:offer-a',{peerId:'sender',offerId:'offer-a',files:[
    {id:'f1',name:'blocked.txt',size:5,status:'pending'},
    {id:'f2',name:'next.txt',size:5,status:'pending'},
  ]});
  t.receiver.run('acceptFile(state.offers.get("sender:offer-a"), state.offers.get("sender:offer-a").files[0])');
  t.receiver.run('acceptFile(state.offers.get("sender:offer-a"), state.offers.get("sender:offer-a").files[1])');
  await flushUntil(()=>t.receiver.state.active?.status==='传输中' && releaseSlice);
  t.receiver.run('cancelJob(state.active)');
  assert.equal(t.receiver.state.jobs[0].status,'正在取消');
  assert.equal(t.receiver.state.jobs[1].status,'排队中');
  assert.equal(t.receiver.state.active?.fileId,'f1');
  await flushUntil(()=>t.a.sending.get('f1')?.cancelled===true);
  releaseSlice(new TextEncoder().encode('hello').buffer);
  await flushUntil(()=>t.receiver.state.jobs[0].status==='已取消' &&
                   t.receiver.state.jobs[1].status==='校验通过，点击保存');
  assert.equal(t.receiver.savedBlobs.length,1);
  assert.equal(await t.receiver.savedBlobs[0].text(),'world');
  const controls=t.senderMessages.filter(x=>typeof x==='string').map(x=>JSON.parse(x).kind);
  assert.ok(controls.includes('file-canceled'));
});

test('cancel just before file-end does not strand the job and same-file retry succeeds', async () => {
  const t=await linkedFilePeers();
  let releaseSlice;
  const content=new Blob(['hello']);
  const slowFile={
    size:5,
    slice(){return {arrayBuffer:()=>new Promise(resolve=>{releaseSlice=resolve;})};},
    arrayBuffer:()=>content.arrayBuffer(),
  };
  t.sender.state.outbound.set('offer-a',new Map([['f1',slowFile]]));
  t.receiver.state.offers.set('sender:offer-a',{peerId:'sender',offerId:'offer-a',
    files:[{id:'f1',name:'hello.txt',size:5,status:'pending'}]});
  const originalSend=t.b.channel.send;
  let lateCancel;
  t.b.channel.send=data=>{
    if(typeof data==='string' && JSON.parse(data).kind==='cancel-file'){
      lateCancel=()=>originalSend(data);
      return;
    }
    originalSend(data);
  };
  t.receiver.run('acceptFile(state.offers.get("sender:offer-a"), state.offers.get("sender:offer-a").files[0])');
  await flushUntil(()=>t.receiver.state.active?.status==='传输中' && releaseSlice);
  t.receiver.run('cancelJob(state.active)');
  assert.equal(t.receiver.state.jobs[0].status,'正在取消');
  releaseSlice(new TextEncoder().encode('hello').buffer);
  await flushUntil(()=>t.senderMessages.some(x=>typeof x==='string' && JSON.parse(x).kind==='file-end'));
  await flushUntil(()=>t.receiver.state.jobs[0].status==='已取消');
  assert.ok(lateCancel,'cancel control was held to simulate the sender already finishing');
  lateCancel();
  await flushUntil(()=>t.sender.state.peers.get('receiver').sending.size===0);
  t.sender.state.outbound.set('offer-a',new Map([['f1',content]]));
  t.receiver.run('retryJob(state.jobs[0])');
  await flushUntil(()=>t.receiver.state.jobs[0].status==='校验通过，点击保存');
  assert.equal(await t.receiver.savedBlobs[0].text(),'hello');
});

test('late cancel acknowledgement must not cancel a new attempt for the same file', async () => {
  const t=await linkedFilePeers();
  const content=new Blob(['hello']);
  t.sender.state.outbound.set('offer-a',new Map([['f1',content]]));
  t.receiver.state.offers.set('sender:offer-a',{peerId:'sender',offerId:'offer-a',
    files:[{id:'f1',name:'hello.txt',size:5,status:'pending'}]});
  const job={peerId:'sender',offerId:'offer-a',fileId:'f1',name:'hello.txt',
    size:5,received:0,chunks:[],status:'已取消',url:null,cancelled:true};
  t.receiver.state.jobs.push(job);
  t.receiver.run('retryJob(state.jobs[0])');
  assert.equal(t.receiver.state.active,job);
  assert.equal(job.cancelled,false);
  t.b.channel.onmessage({data:JSON.stringify({kind:'file-canceled',fileId:'f1'})});
  assert.equal(t.receiver.state.active,job,'stale ack must not finish a non-cancelled retry');
  await flushUntil(()=>job.status==='校验通过，点击保存');
});

test('file-start arriving after cancellation cannot reactivate the cancelled job', async () => {
  const t=await linkedFilePeers();
  t.receiver.state.offers.set('sender:offer-a',{peerId:'sender',offerId:'offer-a',
    files:[{id:'f1',name:'hello.txt',size:5,status:'pending'}]});
  t.receiver.run('acceptFile(state.offers.get("sender:offer-a"), state.offers.get("sender:offer-a").files[0])');
  t.receiver.run('cancelJob(state.active)');
  assert.equal(t.receiver.state.jobs[0].status,'正在取消');
  t.b.channel.onmessage({data:JSON.stringify({kind:'file-start',offerId:'offer-a',fileId:'f1',size:5})});
  assert.equal(t.receiver.state.jobs[0].status,'正在取消');
});

test('queued cancellation remains retryable, and retry re-enters the sequential queue', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("sender","Desktop",true,"gen-sender")');
  const peer=t.state.peers.get('sender');
  peer.ready=true;
  peer.channel.readyState='open';
  const controls=[];
  peer.channel.send=data=>controls.push(JSON.parse(data));
  t.state.offers.set('sender:offer-a',{peerId:'sender',offerId:'offer-a',files:[
    {id:'f1',name:'one.txt',size:5,status:'pending'},
    {id:'f2',name:'two.txt',size:5,status:'pending'}]});
  t.run('acceptFile(state.offers.get("sender:offer-a"),state.offers.get("sender:offer-a").files[0])');
  t.run('acceptFile(state.offers.get("sender:offer-a"),state.offers.get("sender:offer-a").files[1])');
  assert.equal(t.state.active.fileId,'f1');
  t.run('cancelJob(state.jobs[1])');
  assert.equal(t.state.jobs[1].status,'已取消');
  assert.equal(t.state.queue.length,0);
  t.run('retryJob(state.jobs[1])');
  assert.equal(t.state.jobs[1].status,'排队中');
  assert.equal(t.state.queue.length,1);
  assert.equal(t.state.active.fileId,'f1');
  t.run('finishJob("已取消")');
  await flushUntil(()=>t.state.active?.fileId==='f2');
  assert.deepEqual(controls.map(x=>x.fileId),['f1','f2']);
});

test('cancel during checksum processing finishes immediately and permits retry', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("sender","Desktop",true,"gen-sender")');
  const peer=t.state.peers.get('sender');
  peer.ready=true;
  peer.channel.readyState='open';
  const controls=[];
  peer.channel.send=data=>controls.push(JSON.parse(data));
  t.state.offers.set('sender:offer-a',{peerId:'sender',offerId:'offer-a',
    files:[{id:'f1',name:'one.txt',size:5,status:'pending'}]});
  t.run('acceptFile(state.offers.get("sender:offer-a"),state.offers.get("sender:offer-a").files[0])');
  t.run('state.active.status="校验中"');
  t.run('cancelJob(state.active)');
  assert.equal(t.state.jobs[0].status,'已取消');
  assert.equal(t.state.active,null);
  assert.equal(controls.length,1,'already received file-end; sender cancel is unnecessary');
  t.run('retryJob(state.jobs[0])');
  assert.equal(t.state.active?.fileId,'f1');
  assert.equal(t.state.active?.status,'等待发送端');
});

test('sender acknowledges cancellation even if its transfer already finished', async () => {
  const t=await linkedFilePeers();
  t.b.channel.send(JSON.stringify({kind:'cancel-file',fileId:'f1'}));
  await flushUntil(()=>t.senderMessages.some(x=>typeof x==='string' &&
    JSON.parse(x).kind==='file-canceled'));
  assert.equal(t.sender.run('diagnosticsSnapshot().peers[0].transfer.cancelAcksSent'),1);
  await flushUntil(()=>t.receiver.run('diagnosticsSnapshot().peers[0].transfer.cancelAcksReceived')===1);
});

test('a retry before the sender completes its previous file gets an explicit busy error', async () => {
  const t=await linkedFilePeers();
  const source=new Blob(['hello']);
  t.sender.state.outbound.set('offer-a',new Map([['f1',source]]));
  t.a.sending.set('f1',{cancelled:true,cancel(){}});
  t.b.channel.send(JSON.stringify({kind:'request-file',offerId:'offer-a',fileId:'f1'}));
  await flushUntil(()=>t.senderMessages.some(x=>typeof x==='string' &&
    JSON.parse(x).kind==='file-error'));
  assert.match(JSON.parse(t.senderMessages.find(x=>typeof x==='string' &&
    JSON.parse(x).kind==='file-error')).message,/上一笔传输尚未结束/);
});
test('checksum failure quarantines corrupted bytes, then retry succeeds with original payload', async () => {
  let corruption=true;
  const t=await linkedFilePeers({tamperBinary:data=>corruption && data instanceof ArrayBuffer});
  const source=new Blob(['Original protected bytes']);
  t.sender.state.outbound.set('offer-a',new Map([['f1',source]]));
  t.receiver.state.offers.set('sender:offer-a',{peerId:'sender',offerId:'offer-a',
    files:[{id:'f1',name:'payload.txt',size:source.size,status:'pending'}]});
  t.receiver.run('acceptFile(state.offers.get("sender:offer-a"), state.offers.get("sender:offer-a").files[0])');
  await flushUntil(()=>t.receiver.state.jobs[0].status.includes('SHA-256 校验失败'));
  assert.equal(t.receiver.state.jobs[0].url,null,'corrupted download must never be exposed');
  assert.equal(t.receiver.savedBlobs.length,0);
  corruption=false;
  t.receiver.run('retryJob(state.jobs[0])');
  await flushUntil(()=>t.receiver.state.jobs[0].status==='校验通过，点击保存');
  assert.equal(t.receiver.savedBlobs.length,1);
  assert.equal(await realSha256Hex(t.receiver.savedBlobs[0]),await realSha256Hex(source));
});

test('retry of a withdrawn file is rejected when its offer still has other files', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("sender","Desktop",true,"gen-sender")');
  const p=t.state.peers.get('sender');
  p.ready=true; p.channel.readyState='open';
  const sent=[];
  p.channel.send=data=>sent.push(JSON.parse(data));
  t.state.offers.set('sender:offer-a',{peerId:'sender',offerId:'offer-a',files:[
    {id:'f1',name:'withdrawn.txt',size:5,status:'pending'},
    {id:'f2',name:'still-present.txt',size:5,status:'pending'}]});
  t.run('acceptFile(state.offers.get("sender:offer-a"), state.offers.get("sender:offer-a").files[0])');
  t.run('failActive("模拟失败")');
  t.run('withdrawPeerFile("sender","offer-a","f1")');
  assert.equal(t.state.offers.get('sender:offer-a').files.length,1);
  assert.equal(t.state.jobs[0].status,'已撤回','withdrawal removes stale retry action');
  t.run('state.jobs[0].status="失败：模拟失败"');
  t.run('retryJob(state.jobs[0])');
  assert.equal(t.state.jobs[0].status,'已撤回','stale retry cannot queue a withdrawn file');
  assert.equal(t.state.active,null);
  assert.equal(t.state.queue.length,0);
  assert.equal(sent.length,1,'do not send another request for a withdrawn file');
});

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

test('ordinary diagnostics distinguish new room, existing-room join and authenticated resume', async () => {
  const makeWelcome = (id,created) => JSON.stringify({
    type:'welcome',code:'5832',id,token:'local-token',generation:'gen-1',
    name:'Amber Fox',peers:[],created,
  });
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const ws=t.FakeWebSocket.sockets[0];
  ws.open();
  await t.run(`handleServer(${makeWelcome('local-id',true)})`);
  assert.equal(t.run('diagnosticsSnapshot().roomEntry'),'created');
  await t.run(`handleServer(${makeWelcome('local-id',false)})`);
  assert.equal(t.run('diagnosticsSnapshot().roomEntry'),'resumed');
  await t.run(`handleServer(${makeWelcome('new-id',false)})`);
  assert.equal(t.run('diagnosticsSnapshot().roomEntry'),'joined');
  await t.run(`handleServer(${makeWelcome('newer-id',true)})`);
  assert.equal(t.run('diagnosticsSnapshot().roomEntry'),'created');
  const diagnostic=JSON.stringify(t.run('diagnosticsSnapshot()'));
  assert.ok(!diagnostic.includes('local-token'));
  assert.ok(!diagnostic.includes('5832'));
});

test('unexpected disconnect can create same-code room with new identity and retained local files', async () => {
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
  // If this was the only online room member, the server immediately closed
  // the room; reconnection creates a fresh same-code room with a new identity.
  await t.run('handleServer({type:"welcome",code:"5832",id:"new-id",token:"new-token",generation:"gen-2",name:"Amber Fox",peers:[],created:true})');
  assert.equal(t.state.generation,'gen-2');
  assert.equal(t.state.id,'new-id');
  assert.equal(t.state.token,'new-token');
  assert.equal(t.run('diagnosticsSnapshot().roomEntry'),'created');
  assert.match(t.elements.get('feedback').textContent,/创建新房间/);
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

test('cumulative connection timing survives retries and freezes only when P2P is ready', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');
  const first=t.state.peers.get('other');
  const initial=Date.now()-42000;
  first.firstAttemptStartedAt=initial;
  assert.equal(t.run('diagnosticsSnapshot().peers[0].timeToReadySeconds'),null);

  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  const second=t.state.peers.get('other');
  assert.equal(second.attempt,2);
  assert.equal(second.firstAttemptStartedAt,initial);
  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  const reversed=t.state.peers.get('other');
  assert.equal(reversed.attempt,3);
  assert.equal(reversed.firstAttemptStartedAt,initial,'reversing offerer must not reset total setup time');

  reversed.pc.connectionState='connected';
  reversed.pc.iceConnectionState='connected';
  const channel={
    label:'room-files',ordered:true,readyState:'open',sent:[],
    send(data){this.sent.push(JSON.parse(data));},
  };
  reversed.pc.ondatachannel({channel});
  await channel.onopen();
  assert.equal(reversed.verified,true);
  assert.equal(reversed.readyAt,null,'a local ready without reciprocal ready is not complete');
  channel.onmessage({data:JSON.stringify({kind:'ready'})});
  assert.equal(reversed.ready,true);
  assert.ok(reversed.readyAt>=initial);
  const diagnostics=t.run('diagnosticsSnapshot().peers[0]');
  assert.equal(diagnostics.attempt,3);
  assert.ok(diagnostics.elapsedSeconds<15,'current attempt timer is short');
  assert.ok(diagnostics.setupElapsedSeconds>=42,'total spans all three ICE attempts');
  assert.equal(diagnostics.setupElapsedSeconds,diagnostics.timeToReadySeconds);
  assert.equal(t.timers.size,0,'ready clears stale ICE retry timers');

  // Rebuilding a previously ready peer is a fresh measurement, not a
  // continuation of the previous connection's setup time.
  await t.run('createPeer("other","Sky Deer",true,"gen-peer",1,true)');
  const fresh=t.state.peers.get('other');
  assert.equal(fresh.readyAt,null);
  assert.ok(fresh.firstAttemptStartedAt>initial);
  const freshDiagnostics=t.run('diagnosticsSnapshot().peers[0]');
  assert.equal(freshDiagnostics.timeToReadySeconds,null);
  assert.ok(freshDiagnostics.setupElapsedSeconds<10);
});

test('normal diagnostics retain all four bounded ICE attempts and final exhaustion', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');

  const original=t.state.peers.get('other');
  original.pc.iceConnectionState='failed';
  original.pc.oniceconnectionstatechange();
  assert.equal(t.timers.size,1);
  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));

  const second=t.state.peers.get('other');
  assert.equal(second.attempt,2);
  assert.equal(second.attemptHistory.length,1);
  assert.equal(second.attemptHistory[0].retryTrigger,'ice-failed');
  assert.equal(second.attemptHistory[0].role,'offerer');
  assert.equal(second.attemptHistory[0].ice,'failed');

  second.pc.iceConnectionState='checking';
  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  const third=t.state.peers.get('other');
  assert.equal(third.attempt,3);
  assert.equal(third.attemptHistory.length,2);
  assert.equal(third.attemptHistory[1].retryTrigger,'timeout');

  await t.run('handleSignal("other","gen-peer",{type:"offer",attempt:3,sdp:"v=0\\r\\nc=IN IP4 192.168.9.2"})');
  fireNextTimer(t);
  assert.deepEqual(socket.sent.at(-1).signal,{type:'retry',attempt:3});
  await t.run('handleSignal("other","gen-peer",{type:"offer",attempt:4,sdp:"v=0\\r\\nc=IN IP4 192.168.9.3"})');
  const fourth=t.state.peers.get('other');
  assert.equal(fourth.attemptHistory.length,3);
  assert.equal(fourth.attemptHistory[2].role,'answerer');
  assert.equal(fourth.attempt,4);
  fireNextTimer(t);

  const diag=t.run('diagnosticsSnapshot().peers[0]');
  assert.equal(diag.iceAttempts.length,4,'one entry per attempt; never unbounded');
  assert.deepEqual(Array.from(diag.iceAttempts,x=>x.attempt),[1,2,3,4]);
  assert.deepEqual(Array.from(diag.iceAttempts,x=>x.role),['offerer','offerer','answerer','answerer']);
  assert.equal(diag.iceAttempts[3].outcome,'exhausted');
  assert.equal(diag.iceAttempts[3].retryTrigger,'timeout');
  assert.equal(diag.timeToReadySeconds,null);
  assert.equal(diag.canTransfer,false);
  assert.ok(diag.iceAttempts.every(x=>x.durationSeconds>=0 && typeof x.durationSeconds==='number'));
  const raw=JSON.stringify(diag.iceAttempts);
  assert.ok(!raw.includes('192.168.'),'redacted attempt history must not include IPs/SDP');
  assert.ok(!raw.includes('5832'),'redacted attempt history must not include room codes');
  assert.ok(!raw.includes('Sky Deer'),'redacted attempt history must not include device names');
});

test('successful reversed attempt is retained as ready without a false exhausted outcome', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');
  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  const reversed=t.state.peers.get('other');
  reversed.pc.connectionState='connected';
  reversed.pc.iceConnectionState='connected';
  const channel={label:'room-files',ordered:true,readyState:'open',
    send(){}};
  reversed.pc.ondatachannel({channel});
  await channel.onopen();
  channel.onmessage({data:JSON.stringify({kind:'ready'})});
  const diag=t.run('diagnosticsSnapshot().peers[0]');
  assert.equal(diag.iceAttempts.length,3);
  assert.equal(diag.iceAttempts[2].role,'answerer');
  assert.equal(diag.iceAttempts[2].outcome,'ready');
  assert.equal(diag.iceAttempts[2].ice,'connected');
  assert.ok(diag.timeToReadySeconds!==null);
  assert.equal(diag.canTransfer,true);
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
  assert.equal(t.run('diagnosticsSnapshot().peers[0].timeToReadySeconds'),null);
  await channel.onopen();
  assert.equal(peer.localReadySent,true);
  assert.equal(peer.ready,true);
  assert.notEqual(t.run('diagnosticsSnapshot().peers[0].timeToReadySeconds'),null);
  assert.equal(t.timers.size,0);
  assert.deepEqual(channel.sent,[{kind:'ready'},{kind:'file-list-request'}]);
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
  assert.deepEqual(channel.sent,[{kind:'ready'},{kind:'file-list-request'}]);
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
  assert.deepEqual(channel.sent,[{kind:'ready'},{kind:'file-list-request'}]);
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

test('R05: a verified open channel reannounces ready twice without renegotiating ICE', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const ws=t.FakeWebSocket.sockets[0];
  await join(t,ws);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer",4)');
  const peer=t.state.peers.get('other');
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  const packets=[];
  peer.channel.readyState='open';
  peer.channel.send=data=>packets.push(JSON.parse(data));
  await peer.channel.onopen();
  assert.equal(peer.verified,true);
  assert.equal(peer.remoteReady,false);
  assert.equal(packets.filter(p=>p.kind==='ready').length,1);
  const initialOffers=ws.sent.filter(m=>m.signal?.type==='offer').length;

  fireNextTimer(t); // current 15 s timeout must not silently strand P2P handshake
  await flushUntil(()=>packets.some(p=>p.kind==='ready' && p.requestReciprocal===true));
  assert.equal(peer.ready,false,'no file bytes until reciprocal ready is received');
  assert.equal([...t.timers.values()][0]?.ms,5000,'one bounded follow-up');
  fireNextTimer(t);
  await flushUntil(()=>packets.filter(p=>p.kind==='ready').length===3);
  assert.equal(t.timers.size,0,'bounded retries must stop after two reannouncements');
  assert.equal(ws.sent.filter(m=>m.signal?.type==='offer').length,initialOffers);
  const diag=t.run('diagnosticsSnapshot().peers[0]');
  assert.equal(diag.readyRetriesSent,2);
  assert.equal(diag.canTransfer,false);

  await t.run('receiveChannel(state.peers.get("other"),JSON.stringify({kind:"ready",hostHostVerified:true}))');
  assert.equal(peer.ready,true);
  assert.equal(t.timers.size,0);
});

test('R05: a duplicate ready can request one verified echo without a ping-pong loop', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');
  const peer=t.state.peers.get('other');
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  const packets=[];
  peer.channel.readyState='open';
  peer.channel.send=data=>packets.push(JSON.parse(data));
  await peer.channel.onopen();
  await t.run('receiveChannel(state.peers.get("other"),JSON.stringify({kind:"ready"}))');
  const firstCount=packets.filter(p=>p.kind==='ready').length;
  await t.run('receiveChannel(state.peers.get("other"),JSON.stringify({kind:"ready",requestReciprocal:true}))');
  await flushUntil(()=>packets.filter(p=>p.kind==='ready').length===firstCount+1);
  const echoes=packets.filter(p=>p.kind==='ready');
  assert.equal(echoes.at(-1).requestReciprocal,undefined,'echo never requests its own echo');
  await t.run('receiveChannel(state.peers.get("other"),JSON.stringify({kind:"ready",requestReciprocal:true}))');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(packets.filter(p=>p.kind==='ready').length,firstCount+1);
  assert.equal(t.run('diagnosticsSnapshot().peers[0].readyEchoesSent'),1);
});

test('R05: unsafe current path rejects ready retransmissions without opening transfer', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  await join(t,t.FakeWebSocket.sockets[0]);
  await t.run('createPeer("other","Sky Deer",true,"gen-peer")');
  const peer=t.state.peers.get('other');
  peer.pc.connectionState='connected';
  peer.pc.iceConnectionState='connected';
  const packets=[];
  peer.channel.readyState='open';
  peer.channel.send=data=>packets.push(JSON.parse(data));
  await peer.channel.onopen();
  assert.equal(packets.filter(p=>p.kind==='ready').length,1);
  t.run('inspectSelectedPath = async () => ({allowed:false,reason:"unsafe currently selected path",code:"relay"})');
  fireNextTimer(t);
  await flushUntil(()=>t.timers.size===1 && [...t.timers.values()][0].ms===5000);
  fireNextTimer(t);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(packets.filter(p=>p.kind==='ready').length,1,'never reattest unsafe path');
  assert.equal(peer.ready,false);
  assert.equal(t.timers.size,0);
  await t.run('receiveChannel(state.peers.get("other"),JSON.stringify({kind:"ready",requestReciprocal:true}))');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(packets.filter(p=>p.kind==='ready').length,1,'unsafe path also rejects echo');
});

test('R06 idle solo room: silent WebSocket is detected and recreated without losing staged files', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const first=t.FakeWebSocket.sockets[0];
  await join(t,first);
  assert.equal(t.intervals.size,1,'idle joined room must have a heartbeat watchdog');
  const offered={size:5};
  t.state.ownOffers.push({offerId:'offer-1',files:[{id:'f1',name:'sample.txt',size:5}]});
  t.state.outbound.set('offer-1',new Map([['f1',offered]]));
  const beat=[...t.intervals.values()][0];
  assert.equal(beat.ms,20000);
  beat.cb();
  const sent=first.sent.at(-1);
  assert.equal(sent.type,'keepalive');
  assert.equal(typeof sent.seq,'number');
  assert.equal(t.run('diagnosticsSnapshot().signalKeepalive.pending'),true);
  // A black-holed network can leave native WebSocket OPEN and never emit close.
  first.close=()=>{first.readyState=first.constructor.CLOSING;};
  beat.cb();
  assert.equal(t.state.ws,null,'watchdog must not depend on native close');
  assert.equal(t.run('diagnosticsSnapshot().signalKeepalive.timeouts'),1);
  assert.equal(t.state.ownOffers.length,1);
  assert.equal(t.state.outbound.get('offer-1').get('f1'),offered);
  assert.equal(t.intervals.size,0,'do not keep old watchdog alive');
  assert.equal([...t.timers.values()][0].ms,1000);
  fireNextTimer(t);
  const next=t.FakeWebSocket.sockets.at(-1);
  next.open();
  assert.equal(next.sent[0].id,'local-id');
  await t.run('handleServer({type:"welcome",code:"5832",id:"new-id",token:"new-token",generation:"gen-2",name:"Amber Fox",peers:[],created:true})');
  assert.equal(t.run('diagnosticsSnapshot().roomEntry'),'created');
  assert.equal(t.run('diagnosticsSnapshot().localSharedFiles'),1);
  assert.equal(t.run('diagnosticsSnapshot().signalKeepalive.timeouts'),1);
  assert.equal(t.intervals.size,1);
  first.emit('message',{data:JSON.stringify({type:'keepalive-ack',seq:sent.seq})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(t.run('diagnosticsSnapshot().signalKeepalive.acksReceived'),0,'stale ack ignored');
});

test('R06 active idle socket replies to keepalive and manual Leave stops watchdog', async () => {
  const t=harness();
  t.run('connect({type:"enter",code:"5832",name:"Amber Fox"})');
  const socket=t.FakeWebSocket.sockets[0];
  await join(t,socket);
  const tick=[...t.intervals.values()][0].cb;
  tick();
  const seq=socket.sent.at(-1).seq;
  await t.run('handleServer({type:"keepalive-ack",seq:'+(seq+100)+'})');
  assert.equal(t.run('diagnosticsSnapshot().signalKeepalive.pending'),true,'wrong ack is ignored');
  await t.run('handleServer({type:"keepalive-ack",seq:'+seq+'})');
  const healthy=t.run('diagnosticsSnapshot().signalKeepalive');
  assert.equal(healthy.acksReceived,1);
  assert.equal(healthy.timeouts,0);
  assert.equal(healthy.pending,false);
  tick();
  assert.equal(socket.sent.at(-1).type,'keepalive');
  assert.equal(t.state.ws,socket,'responsive socket remains connected');
  t.run('document.getElementById("leave-room").onclick()');
  assert.equal(t.intervals.size,0);
  assert.equal(t.timers.size,0);
});
