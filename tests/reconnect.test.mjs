import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .split('\n').filter(line => !line.startsWith('import ')).join('\n');

// Exercise the real room controller against DOM/WebSocket stubs, without network access.
function harness() {
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
  const context = vm.createContext({
    window: { localStorage: sessionStorage, addEventListener() {} },
    document: {
      getElementById: element,
      createElement: tag => element(Symbol(tag)),
      createTextNode: value => ({textContent: value}),
    },
    sessionStorage,
    location: { protocol: 'https:', host: 'test.example' },
    WebSocket: FakeWebSocket,
    setTimeout: (cb, ms) => { const id = ++nextTimer; timers.set(id, {cb, ms}); return id; },
    clearTimeout: id => timers.delete(id),
    queueMicrotask,
    fetch: async () => { throw Error('no test network'); },
    navigator: {}, crypto: {randomUUID: () => 'test-uuid'},
    Blob, Map, Set, Date, Promise, console,
    DEVICE_NAME_KEY: 'device-key',
    getOrCreateDeviceName: () => 'Amber Fox',
    generateDeviceName: () => 'Amber Fox',
    deviceAvatar: () => '🦊',
    normalizeRoomCode: code => code,
    generateRandomRoomCode: () => '5832',
  });
  vm.runInContext(appSource, context, {filename:'app.js'});
  const run = expression => vm.runInContext(expression, context);
  return {state: run('state'), run, timers, elements, FakeWebSocket};
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
