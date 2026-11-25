import { inspectSelectedPath, isHostCandidateLine } from './route-policy.js';
import { sha256Hex, isSha256Hex, verifySha256 } from './checksum.js';
import { DEVICE_NAME_KEY, deviceAvatar, generateDeviceName, getOrCreateDeviceName } from './device-name.js';
import { generateRandomRoomCode, normalizeRoomCode } from './room-code.js';

// Research prototype only. Browser APIs cannot reliably prove the OS routing path.
// Advisory only: the receiver still buffers complete files in browser memory.
const LARGE_FILE_WARNING_BYTES = 32 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;
const MAX_FILES = 20;
const PEER_CONNECT_TIMEOUT_MS = 15000;
const PEER_PRIMARY_ATTEMPTS = 2;
const PEER_MAX_ATTEMPTS = 4;
const READY_REANNOUNCE_MAX = 2;
const READY_REANNOUNCE_DELAY_MS = 5000;
// Only receives resumed after a tab takeover get a bounded, P2P-only retry.
const HANDOFF_RECEIVE_RETRY_DELAYS_MS = [2000, 5000];
const RECONNECT_MAX_DELAY_MS = 15000;
const SIGNAL_KEEPALIVE_MS = 20000;
let reconnectTimer = null;
let reconnectAttempts = 0;
let signalKeepaliveTimer = null;
let signalRecover = null;
let signalKeepalivePending = null;
let signalKeepaliveSequence = 0;
const signalHealth = { sent: 0, acksReceived: 0, timeouts: 0, disconnects: 0, reconnectsScheduled: 0,
  lastDisconnect: null };
// This short, tab-local event order is safer than sharing full debug logs.
// In particular, it distinguishes a new "created" room from "resumed" after
// an idle disconnect without exposing room/session identifiers or IPs.
const signalHistory = [];
function noteSignalTransition(event, value) {
  const entering = event === 'entry';
  const allowed = entering ? ['created', 'resumed', 'joined']
    : ['socket-close', 'keepalive-timeout', 'keepalive-send-failed'];
  signalHistory.push({
    event: entering ? 'entry' : 'disconnect',
    value: allowed.includes(value) ? value : 'other',
  });
  if (signalHistory.length > 12) signalHistory.shift();
}
const TRANSFER_IDLE_MS = 30000;
const FULL_DEBUG = /(?:^|[?&])debug=1(?:&|$)/.test(location.search || '');
let QA_MODE = /(?:^|[?&])qa=1(?:&|$)/.test(location.search || '');
const QA_START_DELAY_MS = 6000;
let qaArmed = null;
let qaTimer = null;
let qaTriggerAt = null;
let qaLastOutcome = '未开始';
const debugStartedAt = Date.now();
const debugEvents = [];
const $ = id => document.getElementById(id);

// Debug is deliberately explicit: logs contain room codes, credentials,
// unredacted SDP/ICE candidates, browser-visible IPs and file names.
// Data stays in this browser's DevTools; never relay logs to the server.
function trace(event, data = {}) {
  if (!FULL_DEBUG) return;
  const elapsedMs = Date.now() - debugStartedAt;
  debugEvents.push({ elapsedMs, event, data });
  if (debugEvents.length > 300) debugEvents.shift();
  console.log(`[LAN Room debug +${elapsedMs}ms] ${event}`, data);
}
function debugSend(ws, message) {
  trace('websocket.send', message);
  ws.send(JSON.stringify(message));
}
function tracePeer(peer, event, detail = {}) {
  if (!FULL_DEBUG) return;
  trace(event, {
    peerId: peer.id, deviceName: peer.name, generation: peer.generation,
    initiator: peer.initiator, attempt: peer.attempt, stage: peer.stage,
    connectionState: peer.pc.connectionState,
    iceConnectionState: peer.pc.iceConnectionState,
    signalingState: peer.pc.signalingState,
    iceGatheringState: peer.pc.iceGatheringState,
    channelState: peer.channel?.readyState ?? 'none', ...detail,
  });
}
async function traceStats(peer, event) {
  if (!FULL_DEBUG) return;
  try {
    const stats = await peer.pc.getStats();
    // Include all browser-exposed ICE candidate addresses and pair fields.
    tracePeer(peer, event, { stats: Array.from(stats.values(), item => ({ ...item })) });
  } catch (error) {
    tracePeer(peer, `${event}.error`, { error: String(error) });
  }
}
if (FULL_DEBUG) {
  trace('enabled', {
    url: location.href, userAgent: navigator.userAgent,
    note: 'Contains credentials, file names, full SDP/ICE and browser-visible IPs; do not publish raw logs.',
  });
}
const state = {
  ws: null, code: '', id: '', token: '', generation: '', leaving: false, peers: new Map(),
  outbound: new Map(), ownOffers: [], offers: new Map(), jobs: [], queue: [], active: null,
  signalErrors: 0, lastSignalError: '', lastRoomEntry: null,
};

let currentDeviceName;
const localRoomTabId = crypto.randomUUID();
// A room belongs to one active tab per browser profile/origin. Hold the lock
// across WebSocket reconnects; never use a display name or IP as identity.
let roomTabLease = null;
let currentRoomExitRevision = null;
// A deliberate Leave ends every tab of this room in the current browser
// profile; closing a tab never changes this revision.
function roomExitKey(code) { return `lan-room-group-exit:${code}`; }
function readRoomExitRevision(code) {
  try { return window.localStorage.getItem(roomExitKey(code)) || ''; }
  catch { return ''; }
}
function acquireRoomTab(code) {
  if (roomTabLease?.code === code || !navigator.locks?.request) return Promise.resolve(true);
  return new Promise(resolve => {
    navigator.locks.request(`lan-room:${code}`, { ifAvailable: true }, lock => {
      if (!lock) { resolve(false); return; }
      return new Promise(release => {
        roomTabLease = { code, release };
        resolve(true);
      });
    }).catch(error => {
      trace('room.tab.lock.failed', { error: String(error) });
      resolve(false);
    });
  });
}
function releaseRoomTab(notifyChanging = true) {
  closeOwnerRoomChannel(notifyChanging);
  const lease = roomTabLease;
  roomTabLease = null;
  lease?.release();
}

// Browser-profile tabs share ONE WebSocket/P2P controller for each room.
// Followers receive only room UI metadata over BroadcastChannel (never
// credentials, SDP/ICE or cloud file bytes) and forward explicit UI actions.
let ownerRoomChannel = null;
let mirroredRoom = null;
let roomMirrorUpdateTimer = null;
function roomChannelName(code) { return `lan-room-view:${code}`; }

function closeOwnerRoomChannel(notifyChanging = true) {
  if (!ownerRoomChannel) return;
  const owner = ownerRoomChannel;
  ownerRoomChannel = null;
  clearInterval(owner.heartbeat);
  if (roomMirrorUpdateTimer !== null) clearTimeout(roomMirrorUpdateTimer);
  roomMirrorUpdateTimer = null;
  // The current transport tab is leaving. Another live tab will acquire its
  // Web Lock; this is NOT an instruction for the other tabs to leave.
  if (notifyChanging) owner.channel.postMessage({ type: 'owner-changing', code: owner.code });
  owner.channel.close();
}
function roomViewSnapshot() {
  return {
    code: state.code, name: deviceName(), transportTabId: localRoomTabId,
    connected: state.ws?.readyState === WebSocket.OPEN && Boolean(state.generation),
    roomEntry: state.lastRoomEntry,
    peers: [...state.peers.values()].map(peer => ({
      id: peer.id, name: peer.name, ready: peer.ready, reason: peer.reason,
    })),
    ownOffers: state.ownOffers.map(offer => ({
      offerId: offer.offerId, ownerTabId: offer.ownerTabId,
      files: offer.files.map(file => ({ ...file })),
    })),
    offers: [...state.offers.values()].map(offer => ({
      peerId: offer.peerId, offerId: offer.offerId,
      files: offer.files.map(file => ({ ...file })),
    })),
    jobs: state.jobs.map(job => ({
      peerId: job.peerId, offerId: job.offerId, fileId: job.fileId,
      name: job.name, size: job.size, received: job.received,
      status: job.status, url: job.url || null, cancelled: job.cancelled,
      active: state.active === job, queued: state.queue.includes(job),
      recovering: job.recovering === true,
    })),
    diagnostics: diagnosticsSnapshot(),
    feedback: $('feedback').textContent,
    feedbackError: $('feedback').classList.contains('error'),
  };
}
function roomJobKey(job) {
  return `${job.peerId}:${job.offerId}:${job.fileId}`;
}
// Share browser-local File/Blob handles separately from frequent status
// snapshots. No bytes or credentials go to the signalling server.
function broadcastRoomHandoff() {
  if (!ownerRoomChannel || mirroredRoom || state.code !== ownerRoomChannel.code) return;
  ownerRoomChannel.channel.postMessage({
    type: 'handoff',
    code: state.code,
    session: state.id && state.token ? { id: state.id, token: state.token } : null,
    transportTabId: localRoomTabId,
    sources: [...state.outbound].map(([offerId, files]) => ({
      offerId, files: [...files].map(([fileId, file]) => ({ fileId, file })),
    })),
    // Keep the source handles and their visible file metadata together.
    // The regular UI snapshot is coalesced, so an owner leaving immediately
    // after Share must not leave a follower with files but no file-list entry.
    ownOffers: state.ownOffers.map(offer => ({
      offerId: offer.offerId, ownerTabId: offer.ownerTabId,
      files: offer.files.map(file => ({ ...file })),
    })),
    saved: state.jobs.filter(job => job.blob && job.url).map(job => ({
      key: roomJobKey(job), blob: job.blob,
    })),
  });
}
function broadcastRoomView() {
  if (!ownerRoomChannel || mirroredRoom || state.code !== ownerRoomChannel.code) return;
  ownerRoomChannel.channel.postMessage({ type: 'snapshot', view: roomViewSnapshot() });
}
function scheduleRoomView() {
  if (!ownerRoomChannel || mirroredRoom || roomMirrorUpdateTimer !== null) return;
  roomMirrorUpdateTimer = setTimeout(() => {
    roomMirrorUpdateTimer = null;
    broadcastRoomView();
  }, 120);
}
function mirrorActionsUnavailable() {
  return Boolean(mirroredRoom?.stale);
}
function updateMirrorControls() {
  const unavailable = mirrorActionsUnavailable();
  $('drop-zone').disabled = unavailable;
  $('send-files').disabled = unavailable;
  $('edit-device-name').disabled = unavailable;
}
function sendMirrorAction(action) {
  if (!mirroredRoom) return;
  if (mirrorActionsUnavailable()) {
    feedback('房间连接正在恢复，请稍后重试', true);
    return;
  }
  mirroredRoom.channel.postMessage({ type: 'action', tabId: localRoomTabId, action });
}
function updateMirrorResources(mirror, message) {
  mirror.session = message.session || null;
  mirror.transportTabId = message.transportTabId || mirror.transportTabId;
  mirror.sources = new Map((message.sources || []).map(offer => [
    offer.offerId, new Map(offer.files.map(item => [item.fileId, item.file])),
  ]));
  if (Array.isArray(message.ownOffers)) {
    mirror.sharedOffers = message.ownOffers.map(offer => ({
      offerId: offer.offerId, ownerTabId: offer.ownerTabId,
      files: offer.files.map(file => ({ ...file })),
    }));
  }
  for (const item of message.saved || []) {
    if (!(item.blob instanceof Blob)) continue;
    mirror.savedBlobs.set(item.key, item.blob);
    if (!mirror.savedUrls.has(item.key)) {
      mirror.savedUrls.set(item.key, URL.createObjectURL(item.blob));
    }
  }
  if (mirror.view) {
    if (mirror.sharedOffers) {
      mirror.view.ownOffers = mirror.sharedOffers;
      state.ownOffers = mirror.sharedOffers;
      renderSentFiles();
    }
    for (const job of state.jobs) {
      const url = mirror.savedUrls.get(roomJobKey(job));
      if (url) job.url = url;
    }
    renderRoomFiles();
  }
}
function applyMirroredView(view) {
  if (!mirroredRoom || view.code !== mirroredRoom.code) return;
  const mirror = mirroredRoom;
  mirror.view = view;
  mirror.transportTabId = view.transportTabId || mirror.transportTabId;
  mirror.lastUpdate = Date.now();
  mirror.stale = false;
  state.code = view.code;
  state.lastRoomEntry = view.roomEntry;
  state.generation = view.connected ? 'mirrored' : '';
  state.peers = new Map(view.peers.map(peer => [peer.id, peer]));
  state.ownOffers = mirror.sharedOffers || view.ownOffers;
  state.offers = new Map(view.offers.map(offer => [`${offer.peerId}:${offer.offerId}`, offer]));
  state.jobs = view.jobs.map(job => ({ ...job, chunks: [],
    url: mirror.savedUrls.get(roomJobKey(job)) || job.url }));
  state.active = state.jobs.find(job => job.active) || null;
  state.queue = state.jobs.filter(job => job.queued);
  currentDeviceName = view.name;
  if ($('my-device-label').contentEditable !== 'plaintext-only') updateDeviceAvatar();
  $('room-name').textContent = view.code;
  $('room-code-input').value = view.code;
  showRoom(true);
  renderPeers();
  renderSentFiles();
  renderRoomFiles();
  renderDiagnostics();
  updateMirrorControls();
  $('qa-panel').hidden = true;
  $('qa-enable').hidden = true;
  feedback(view.feedback || '房间信息已同步', view.feedbackError);
}
function closeMirroredRoom() {
  if (!mirroredRoom) return;
  const mirror = mirroredRoom;
  mirror.takeoverAbort?.abort();
  if (mirror.entryTimeout) clearTimeout(mirror.entryTimeout);
  mirror.entryResolve?.();
  clearInterval(mirror.watchdog);
  mirror.channel.close();
  for (const url of mirror.savedUrls?.values() || []) URL.revokeObjectURL(url);
  try { sessionStorage.removeItem('lan-room-mirror-code'); }
  catch { /* Storage may be blocked. */ }
  $('qa-panel').hidden = !QA_MODE;
  $('qa-enable').hidden = QA_MODE;
  mirroredRoom = null;
  state.code = ''; state.generation = ''; state.lastRoomEntry = null;
  state.id = ''; state.token = '';
  state.peers.clear(); state.ownOffers = []; state.offers.clear();
  state.jobs = []; state.queue = []; state.active = null;
  showRoom(false);
  renderPeers(); renderSentFiles(); renderRoomFiles();
  updateMirrorControls();
}
// Every follower queues for the room-specific Web Lock. The browser grants it
// to exactly one surviving tab when the old controller leaves/closes.
function awaitRoomTakeover(mirror) {
  if (!navigator.locks?.request || !window.BroadcastChannel) return;
  const abort = new AbortController();
  mirror.takeoverAbort = abort;
  navigator.locks.request(`lan-room:${mirror.code}`, { signal: abort.signal }, lock => {
    if (!lock || mirroredRoom !== mirror) return;
    // An explicit group exit may have happened before this lock callback.
    // Prevent the waiting tab from resurrecting that exited room.
    if (readRoomExitRevision(mirror.code) !== mirror.exitRevision) {
      closeMirroredRoom();
      currentRoomExitRevision = null;
      feedback('已退出房间');
      return;
    }
    return new Promise(release => {
      roomTabLease = { code: mirror.code, release };
      promoteMirroredRoom(mirror);
    });
  }).catch(error => {
    if (error?.name !== 'AbortError') {
      trace('room.tab.takeover.failed', { error: String(error) });
      if (mirroredRoom === mirror) feedback('房间自动恢复失败，请重试进入房间', true);
    }
  });
}
function promoteMirroredRoom(mirror) {
  if (mirroredRoom !== mirror || !mirror.view) {
    // Without a previously received room snapshot, keep the known code and
    // enter afresh instead of claiming stale file/session state.
    mirror.view ??= { code: mirror.code, name: deviceName(),
      roomEntry: null, ownOffers: [], offers: [], jobs: [] };
  }
  clearInterval(mirror.watchdog);
  if (mirror.entryTimeout) clearTimeout(mirror.entryTimeout);
  mirror.entryResolve?.();
  mirror.channel.close();
  mirroredRoom = null;
  const view = mirror.view;
  state.code = mirror.code;
  state.id = mirror.session?.id || '';
  state.token = mirror.session?.token || '';
  state.generation = '';
  state.lastRoomEntry = view.roomEntry;
  state.peers = new Map();
  state.offers = new Map();
  // All tabs represent one logical device. File/Blob handles already cloned
  // to this surviving tab remain device-owned regardless of which tab picked
  // the file, even when that original selecting tab closed.
  state.ownOffers = (mirror.sharedOffers || view.ownOffers).filter(offer => {
    const files = mirror.sources.get(offer.offerId);
    offer.files = offer.files.filter(file => files?.has(file.id));
    return offer.files.length;
  });
  state.outbound = new Map([...mirror.sources].filter(([offerId]) =>
    state.ownOffers.some(offer => offer.offerId === offerId)));
  state.jobs = view.jobs.map(job => {
    const key = roomJobKey(job);
    const blob = mirror.savedBlobs.get(key);
    const url = mirror.savedUrls.get(key) || null;
    const recovering = !url && !job.cancelled && (job.active || job.queued ||
      job.recovering || job.status === '传输中' || job.status === '校验中');
    const missingSavedFile = !url && Boolean(job.url);
    return { ...job, blob: blob || null, url, chunks: [], active: false, queued: false,
      recovering: Boolean(recovering),
      received: recovering ? 0 : job.received,
      status: recovering ? '等待连接恢复后重新接收' :
        missingSavedFile ? '失败：原下载数据不可用' : job.status };
  });
  state.queue = [];
  state.active = null;
  state.leaving = false;
  try { sessionStorage.removeItem('lan-room-mirror-code'); }
  catch { /* Storage may be blocked. */ }
  updateMirrorControls();
  $('qa-panel').hidden = !QA_MODE;
  $('qa-enable').hidden = QA_MODE;
  showRoom(true);
  $('room-name').textContent = mirror.code;
  renderPeers(); renderSentFiles(); renderRoomFiles();
  startOwnerRoomChannel(mirror.code);
  feedback('正在恢复房间连接…');
  connect({ type: 'enter', code: mirror.code, name: deviceName(),
    ...(state.id && state.token ? { id: state.id, token: state.token } : {}) });
}
async function openMirroredRoom(code) {
  if (!window.BroadcastChannel) {
    setEntryLoading(false);
    feedback('当前浏览器不支持房间页面同步，请使用另一标签页', true);
    return;
  }
  const channel = new BroadcastChannel(roomChannelName(code));
  try { sessionStorage.setItem('lan-room-mirror-code', code); }
  catch { /* This tab can still mirror without stored room-code prefill. */ }
  const mirror = { code, channel, view: null, session: null, transportTabId: null,
    exitRevision: currentRoomExitRevision, sources: new Map(),
    savedBlobs: new Map(), savedUrls: new Map(), lastUpdate: Date.now(),
    stale: false, takeoverAbort: null, watchdog: null };
  mirroredRoom = mirror;
  mirror.watchdog = setInterval(() => {
    if (mirroredRoom !== mirror || !mirror.view ||
        mirror.stale || Date.now() - mirror.lastUpdate < 30000) return;
    mirror.stale = true;
    mirror.view.connected = false;
    state.generation = '';
    renderPeers(); renderRoomFiles(); updateMirrorControls();
    feedback('正在恢复房间连接…');
  }, 5000);
  // Start lock waiting immediately, even before the first snapshot: this
  // also covers the first tab closing during the second tab's entry.
  awaitRoomTakeover(mirror);
  let connected = false;
  await new Promise(resolve => {
    mirror.entryResolve = resolve;
    mirror.entryTimeout = setTimeout(() => {
      if (!connected && mirroredRoom === mirror) {
        closeMirroredRoom();
        setEntryLoading(false);
        feedback('房间暂时无法同步，请重试进入房间', true);
      }
      resolve();
    }, 6000);
    channel.onmessage = ({ data }) => {
      if (mirroredRoom !== mirror) return;
      if (data.type === 'snapshot' && data.view?.code === code) {
        if (!connected) { connected = true; clearTimeout(mirror.entryTimeout); resolve(); }
        applyMirroredView(data.view);
      } else if (data.type === 'handoff' && data.code === code) {
        updateMirrorResources(mirror, data);
      } else if (data.type === 'pending' && data.code === code) {
        if (!connected) {
          connected = true; clearTimeout(mirror.entryTimeout); resolve();
          state.code = code; showRoom(true);
          $('room-name').textContent = code;
          feedback('正在同步房间信息…');
        }
      } else if (data.type === 'owner-changing' && data.code === code) {
        feedback('正在恢复房间连接…');
      } else if (data.type === 'leave-all' && data.code === code) {
        leaveRoomLocally();
      }
    };
    channel.postMessage({ type: 'hello' });
  });
}
function handleMirroredAction(action, tabId) {
  if (!action || !ownerRoomChannel || !state.code || state.code !== ownerRoomChannel.code) return;
  const offer = state.offers.get(`${action.peerId}:${action.offerId}`);
  const file = offer?.files.find(item => item.id === action.fileId);
  const job = state.jobs.find(item => item.peerId === action.peerId &&
    item.offerId === action.offerId && item.fileId === action.fileId);
  switch (action.kind) {
    case 'rename': saveDeviceName(action.name); break;
    case 'share': if (Array.isArray(action.files)) shareFiles(action.files, tabId); break;
    case 'withdraw': withdrawSharedFile(action.offerId, action.fileId); break;
    case 'accept': if (offer && file && state.peers.get(offer.peerId)?.ready) acceptFile(offer, file); break;
    case 'cancel': if (job) cancelJob(job); break;
    case 'retry': if (job) retryJob(job); break;
  }
}
async function startOwnerRoomChannel(code) {
  if (!window.BroadcastChannel) return;
  closeOwnerRoomChannel();
  const channel = new BroadcastChannel(roomChannelName(code));
  const owner = { code, channel, heartbeat: null };
  ownerRoomChannel = owner;
  owner.heartbeat = setInterval(broadcastRoomView, 4000);
  channel.onmessage = ({ data }) => {
    if (data?.type === 'hello') {
      if (state.code === code) {
        // A tab becomes visibly joined only after its takeover credentials
        // and local File handles have been enqueued first on this channel.
        broadcastRoomHandoff();
        broadcastRoomView();
      } else {
        channel.postMessage({ type: 'pending', code });
      }
    } else if (data?.type === 'action') {
      handleMirroredAction(data.action, data.tabId);
    } else if (data?.type === 'leave-all' && data.code === code) {
      leaveRoomLocally();
    }
  };
}
try { currentDeviceName = getOrCreateDeviceName(window.localStorage); }
catch { currentDeviceName = generateDeviceName(); }

const elem = (tag, className = '', content = '') => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (content !== '') e.textContent = content;
  return e;
};
function addButton(parent, text, action, cls = 'secondary small-button') {
  const button = elem('button', cls, text);
  button.type = 'button';
  button.addEventListener('click', action);
  parent.append(button);
  return button;
}
const humanSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576
  ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1073741824
    ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1073741824).toFixed(2)} GB`;
function feedback(text, error = false) {
  $('feedback').textContent = text;
  $('feedback').className = error ? 'feedback error' : 'feedback';
  scheduleRoomView();
}
let toastTimer = null;
function showToast(message) {
  if (toastTimer !== null) clearTimeout(toastTimer);
  $('toast-message').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
    toastTimer = null;
  }, 2400);
}
function setEntryLoading(loading) {
  $('enter-room').disabled = loading;
  $('enter-room').setAttribute('aria-busy', String(loading));
  $('entry-loading-icon').hidden = !loading;
  $('entry-button-arrow').hidden = loading;
  $('entry-button-label').textContent = loading ? '正在连接房间…' : '进入房间';
}
function showRoom(visible) {
  $('room-screen').hidden = !visible;
  $('home-screen').hidden = visible;
  if (visible) setEntryLoading(false);
  updateConnectionSummary();
}
function updateConnectionSummary() {
  const status = $('connection-status');
  if ($('room-screen').hidden) {
    status.textContent = '未连接';
    status.dataset.state = 'offline';
    return;
  }
  if (mirrorActionsUnavailable()) {
    status.textContent = '房间同步中断';
    status.dataset.state = 'offline';
    return;
  }
  if (!(mirroredRoom ? mirroredRoom.view?.connected : state.ws?.readyState === WebSocket.OPEN) ||
      !state.generation) {
    status.textContent = '正在恢复连接';
    status.dataset.state = 'waiting';
    return;
  }
  const peers = [...state.peers.values()];
  const ready = peers.filter(peer => peer.ready).length;
  status.textContent = !peers.length ? '房间已连接'
    : ready === peers.length ? '文件直连就绪'
      : ready ? '部分设备已连接' : '直连未就绪';
  status.dataset.state = !peers.length ? 'room' : ready === peers.length ? 'ready' : 'waiting';
}
function sendSignal(to, signal) {
  const peer = state.peers.get(to);
  if (peer?.generation && state.ws?.readyState === WebSocket.OPEN) {
    debugSend(state.ws, { type: 'signal', to, toGeneration: peer.generation, signal });
  } else {
    trace('signal.skipped', { to, signal, peerGeneration: peer?.generation, websocketState: state.ws?.readyState });
  }
}
// Privacy-reduced counters expose control-flow failures without file IDs,
// names, room codes, candidate addresses or packet payloads.
const TRANSFER_CONTROLS = new Set(['request-file', 'file-request-ack', 'file-start', 'file-end', 'file-error',
  'cancel-file', 'file-canceled', 'route-proof-request', 'route-proof',
  'file-list', 'file-list-request']);
function countTransfer(peer, event) {
  if (!peer) return;
  peer.transferEvents ??= {};
  peer.transferEvents[event] = (peer.transferEvents[event] || 0) + 1;
  peer.lastTransferEvent = event;
}
function sendPeer(peer, control) {
  if (!peer?.ready || peer.channel?.readyState !== 'open') {
    if (TRANSFER_CONTROLS.has(control.kind)) countTransfer(peer, 'send-unavailable');
    return false;
  }
  tracePeer(peer, 'datachannel.send', { control });
  try {
    peer.channel.send(JSON.stringify(control));
    if (TRANSFER_CONTROLS.has(control.kind)) countTransfer(peer, control.kind + ':sent');
    return true;
  } catch (err) {
    countTransfer(peer, 'send-error');
    tracePeer(peer, 'datachannel.send.failed', { kind: control.kind, error: String(err) });
    return false;
  }
}
function deviceName() { return currentDeviceName; }
function updateDeviceAvatar() {
  $('home-device-avatar').textContent = deviceAvatar(deviceName());
  $('home-device-label').textContent = deviceName();
  $('my-device-avatar').textContent = deviceAvatar(deviceName());
  $('my-device-label').textContent = deviceName();
}
function saveDeviceName(rawName) {
  if (mirrorActionsUnavailable()) {
    feedback('房间同步中断，暂时无法修改设备名称', true);
    return null;
  }
  const name = String(rawName ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40) {
    feedback('设备名称需要为 1–40 个字符', true);
    return null;
  }
  const changed = name !== currentDeviceName;
  currentDeviceName = name;
  updateDeviceAvatar();
  if (changed) {
    try { window.localStorage.setItem(DEVICE_NAME_KEY, name); }
    catch { /* Private mode may deny storage. */ }
    if (mirroredRoom) sendMirrorAction({ kind: 'rename', name });
    else if (state.code && state.ws?.readyState === WebSocket.OPEN) {
      debugSend(state.ws, { type: 'rename', name });
    }
    renderPeers();
    renderRoomFiles();
  }
  return name;
}
function beginDeviceNameEdit(labelId) {
  const label = $(labelId);
  if (label.contentEditable === 'plaintext-only') return;
  label.contentEditable = 'plaintext-only';
  label.setAttribute('role', 'textbox');
  label.setAttribute('aria-label', '编辑设备名称，回车保存，Esc 取消');
  label.focus();
  const range = document.createRange?.();
  const selection = window.getSelection?.();
  if (range && selection) {
    range.selectNodeContents(label);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}
function finishDeviceNameEdit(labelId, cancel = false) {
  const label = $(labelId);
  if (label.contentEditable !== 'plaintext-only') return;
  const nextName = label.textContent;
  label.contentEditable = 'false';
  label.removeAttribute('role');
  label.removeAttribute('aria-label');
  const previousName = deviceName();
  if (!cancel && saveDeviceName(nextName) && deviceName() !== previousName) {
    showToast('设备名称已修改');
  }
  updateDeviceAvatar();
}
function rememberRoom() {
  sessionStorage.setItem('lan-room-session', JSON.stringify({
    code: state.code, id: state.id, token: state.token,
  }));
}
function remembered() {
  try { return JSON.parse(sessionStorage.getItem('lan-room-session') || 'null'); }
  catch { return null; }
}
// WebSocket preserves message arrival order; await each SDP/ICE operation in that order.
// Async event listeners without a queue race setRemoteDescription and ICE candidates.
function orderedMessageHandler(handler, reportError) {
  let pending = Promise.resolve();
  return message => {
    pending = pending.then(() => handler(message)).catch(reportError);
    return pending;
  };
}
function recordSignalError(message) {
  trace('signaling.error', { message });
  state.signalErrors += 1;
  state.lastSignalError = String(message || '信令错误')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]').slice(0, 160);
  renderDiagnostics();
}
function stopReconnect() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}
function stopSignalKeepalive() {
  if (signalKeepaliveTimer !== null) clearInterval(signalKeepaliveTimer);
  signalKeepaliveTimer = null;
  signalKeepalivePending = null;
}
// Browser JavaScript cannot observe native WebSocket ping/pong frames. An
// application-level ack makes even a silent one-member room observable.
function startSignalKeepalive(ws, onLost) {
  stopSignalKeepalive();
  signalKeepaliveTimer = setInterval(() => {
    if (state.ws !== ws || state.leaving) return;
    if (ws.readyState !== WebSocket.OPEN || signalKeepalivePending !== null) {
      signalHealth.timeouts += 1;
      signalHealth.lastDisconnect = 'keepalive-timeout';
      trace('websocket.keepalive.timeout', { pending: signalKeepalivePending });
      // Detach and schedule recovery NOW: close() on a black-holed network
      // may not fire a browser close event until the TCP timeout.
      onLost('keepalive-timeout');
      try { ws.close(); } catch { /* Already unusable. */ }
      return;
    }
    const seq = ++signalKeepaliveSequence;
    try {
      ws.send(JSON.stringify({ type: 'keepalive', seq }));
      signalHealth.sent += 1;
      signalKeepalivePending = seq;
      trace('websocket.keepalive.sent', { seq });
      renderDiagnostics();
    } catch (error) {
      signalHealth.timeouts += 1;
      signalHealth.lastDisconnect = 'keepalive-send-failed';
      trace('websocket.keepalive.send-failed', { error: String(error) });
      onLost('keepalive-send-failed');
      try { ws.close(); } catch { /* Already unusable. */ }
    }
  }, SIGNAL_KEEPALIVE_MS);
}
function scheduleReconnect(action) {
  if (state.leaving || reconnectTimer !== null || !(state.code || action.code)) return;
  const seconds = Math.min(RECONNECT_MAX_DELAY_MS, 1000 * (2 ** Math.min(reconnectAttempts, 4))) / 1000;
  reconnectAttempts += 1;
  signalHealth.reconnectsScheduled += 1;
  trace('websocket.reconnect.scheduled', { delaySeconds: seconds, action, currentRoom: state.code });
  feedback(`连接中断，将在 ${seconds} 秒后自动恢复…`, true);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (state.leaving || state.ws) return;
    connect({
      type: 'enter', code: state.code || action.code, name: deviceName(),
      ...(state.id && state.token ? { id: state.id, token: state.token } : {}),
    });
  }, seconds * 1000);
}
function connect(action) {
  if (state.ws && state.ws.readyState < WebSocket.CLOSING) return;
  stopReconnect();
  if (!state.code) setEntryLoading(true);
  feedback(state.code ? '正在恢复房间连接…' : '正在连接房间…');
  state.leaving = false;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  state.ws = ws;
  trace('websocket.created', { url: ws.url, action, reconnectAttempts });
  const onDisconnected = (reason = 'socket-close') => {
    if (state.ws !== ws) return;
    stopSignalKeepalive();
    signalRecover = null;
    if (reason !== 'keepalive-timeout' && reason !== 'keepalive-send-failed') {
      signalHealth.lastDisconnect = reason;
    }
    signalHealth.disconnects += 1;
    noteSignalTransition('disconnect', reason);
    state.ws = null;
    qaCancelPlan();
    const wasJoined = Boolean(state.code);
    if (!wasJoined) setEntryLoading(false);
    state.generation = '';
    const oldPeers = [...state.peers.values()];
    state.peers.clear();
    for (const peer of oldPeers) {
      clearTimeout(peer.connectTimer);
      peer.pc.close();
    }
    // WebSocket recovery rebuilds every WebRTC peer. Preserve unfinished
    // receive *intent*, not old partial bytes or obsolete send permissions.
    // The receiver may request the same file only after a fresh verified P2P
    // channel reannounces its original offer and matching file metadata.
    suspendReceivesForSignalRecovery();
    state.offers.clear();
    if (!state.leaving && (wasJoined || action.code)) {
      // Keep locally staged File objects; renewed peers receive their catalog.
      showRoom(wasJoined);
      scheduleReconnect(action);
    } else {
      releaseRoomTab();
      showRoom(false);
      state.code = ''; state.ownOffers = []; state.outbound.clear();
    }
    renderPeers(); renderRoomFiles(); renderSentFiles();
  };
  signalRecover = onDisconnected;
  ws.addEventListener('open', () => {
    trace('websocket.open', { action });
    if (state.ws === ws) debugSend(ws, action);
  });
  const processMessage = orderedMessageHandler(
    msg => state.ws === ws ? handleServer(msg) : undefined,
    err => {
      trace('websocket.message.handler.error', { error: String(err), stack: err?.stack });
      recordSignalError(err.message);
      feedback(`连接处理失败：${err.message}`, true);
    },
  );
  ws.addEventListener('message', event => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { return; }
    trace('websocket.receive', msg);
    void processMessage(msg);
  });
  ws.addEventListener('close', event => {
    trace('websocket.close', { code: event.code, reason: event.reason, wasClean: event.wasClean });
    onDisconnected();
  });
  ws.addEventListener('error', event => {
    trace('websocket.error', { type: event.type, readyState: ws.readyState });
    feedback(state.code ? '协调服务暂不可用，正在等待恢复…' : '无法连接协调服务，请检查地址与网络', true);
  });
}
async function handleServer(msg) {
  switch (msg.type) {
    case 'keepalive-ack':
      if (msg.seq === signalKeepalivePending && state.ws?.readyState === WebSocket.OPEN) {
        signalKeepalivePending = null;
        signalHealth.acksReceived += 1;
        trace('websocket.keepalive.ack', { seq: msg.seq });
        renderDiagnostics();
      }
      break;
    case 'error':
      recordSignalError(msg.message);
      feedback(msg.message || '未知错误', true);
      // On reconnect, the prior room code remains set but welcome has not
      // arrived yet. Close the rejected socket so the retry loop can continue.
      if (!state.generation && state.ws) {
        if (!state.code) state.leaving = true;
        state.ws.close();
      }
      break;
    case 'welcome': {
      const restored = Boolean(state.code);
      const rememberedSession = remembered();
      const previousId = state.code === msg.code && state.id ? state.id
        : rememberedSession?.code === msg.code ? rememberedSession.id : null;
      state.lastRoomEntry = msg.created === true ? 'created'
        : previousId && previousId === msg.id ? 'resumed' : 'joined';
      // A freshly created room has no previous sending member or catalog.
      // Do not make an old remote receive appear indefinitely recoverable.
      if (restored && msg.created === true) {
        for (const job of state.jobs) {
          if (!job.recovering) continue;
          job.recovering = false;
          job.status = '失败：原房间已关闭，请重新选择接收';
        }
      }
      stopReconnect();
      reconnectAttempts = 0;
      state.code = msg.code; state.id = msg.id; state.token = msg.token; state.generation = msg.generation;
      noteSignalTransition('entry', state.lastRoomEntry);
      trace('room.joined', { roomCode: state.code, id: state.id, token: state.token,
        generation: state.generation, peers: msg.peers, resumed: restored });
      rememberRoom(); showRoom(true); $('room-name').textContent = msg.code;
      broadcastRoomHandoff();
      $('room-code-input').value = msg.code;
      if (state.ws && signalRecover) startSignalKeepalive(state.ws, signalRecover);
      // Resume may restore a server-side name from before the last local edit.
      if (msg.name !== currentDeviceName) {
        state.ws?.send(JSON.stringify({ type: 'rename', name: currentDeviceName }));
      }
      feedback(restored && msg.created === true
        ? '原房间已关闭，已使用原房间码创建新房间，正在重新建立 P2P 直连'
        : restored ? '房间连接已恢复，正在重建 P2P 直连' : '已进入房间，等待设备 P2P 直连');
      for (const other of msg.peers) await createPeer(other.id, other.name, true, other.generation);
      renderPeers(); renderRoomFiles(); renderSentFiles(); break;
    }
    case 'peer-online':
      if (msg.id !== state.id) await createPeer(msg.id, msg.name, false, msg.generation);
      renderPeers(); break;
    case 'peer-offline':
      dropPeer(msg.id, msg.generation);
      break;
    case 'peer-unavailable':
      if (dropPeer(msg.id, msg.generation)) feedback('目标设备连接已失效，已清理旧会话');
      break;
    case 'peer-name': {
      const peer = state.peers.get(msg.id);
      if (peer) { peer.name = msg.name; renderPeers(); renderRoomFiles(); }
      break;
    }
    case 'signal':
      await handleSignal(msg.from, msg.fromGeneration, msg.signal); break;
    default: break;
  }
}

function dropPeer(id, generation) {
  const peer = state.peers.get(id);
  if (!peer || (generation && peer.generation !== generation)) return false;
  tracePeer(peer, 'peer.dropped');
  if (qaArmed?.peerId === id) qaCancelPlan();
  clearTimeout(peer.connectTimer);
  state.peers.delete(id);
  peer.pc.close();
  if (state.active?.peerId === id) failActive('发送设备已离线');
  discardPeerOffers(id);
  renderPeers(); renderRoomFiles();
  return true;
}
// Keep only bounded, redacted per-attempt outcomes. Browser IPs, SDP,
// credentials and file metadata must never enter ordinary diagnostics.
function iceAttemptSnapshot(peer, outcome) {
  return {
    attempt: peer.attempt,
    role: peer.initiator ? 'offerer' : 'answerer',
    outcome,
    durationSeconds: Math.max(0, Math.round(
      ((peer.readyAt ?? peer.exhaustedAt ?? Date.now()) - peer.startedAt) / 1000)),
    stage: peer.stage,
    ice: peer.pc.iceConnectionState,
    connection: peer.pc.connectionState,
    channel: peer.channel?.readyState ?? 'none',
    candidatesSent: peer.candidateCount || 0,
    candidatesReceived: peer.remoteCandidateCount || 0,
    retryTrigger: peer.retryTrigger ?? null,
  };
}
function schedulePeerTimeout(peer, delay = PEER_CONNECT_TIMEOUT_MS) {
  clearTimeout(peer.connectTimer);
  tracePeer(peer, 'peer.connect.timeout.scheduled', { delayMs: delay });
  peer.connectTimer = setTimeout(() => {
    tracePeer(peer, 'peer.connect.timeout.fired', { delayMs: delay });
    void traceStats(peer, 'peer.connect.timeout.stats');
    if (state.peers.get(peer.id) !== peer || peer.ready ||
        peer.pc.connectionState === 'closed' ||
        state.ws?.readyState !== WebSocket.OPEN) return;
    if (peer.channel?.readyState === 'open' && peer.pc.connectionState === 'connected' &&
        peer.pc.iceConnectionState !== 'failed') {
      // RTC transport is healthy; a missing app-level ready must not trigger
      // ICE renegotiation, but must not appear to be a completed transfer path.
      if (peer.verified && !peer.remoteReady) {
        peer.reason = '文件通道已打开，但尚未收到对端的安全路径确认';
        tracePeer(peer, 'datachannel.ready.timeout', {
          localReadySent: peer.localReadySent, remoteReady: peer.remoteReady,
        });
        // Recover a missed application ready without restarting healthy ICE.
        // Re-attest the CURRENT selected path before each bounded P2P control.
        if (peer.readyRetryAttempts < READY_REANNOUNCE_MAX) {
          peer.readyRetryAttempts += 1;
          void reannounceVerifiedReady(peer, true).finally(() => {
            if (state.peers.get(peer.id) === peer && !peer.remoteReady &&
                peer.channel?.readyState === 'open' &&
                peer.pc.connectionState === 'connected' &&
                peer.readyRetryAttempts < READY_REANNOUNCE_MAX) {
              schedulePeerTimeout(peer, READY_REANNOUNCE_DELAY_MS);
            }
          });
        }
        renderPeers();
      }
      return;
    }
    peer.retryTrigger = peer.pc.iceConnectionState === 'failed' ? 'ice-failed'
      : peer.pc.connectionState === 'failed' ? 'transport-failed'
      : peer.pc.connectionState === 'disconnected' ? 'transport-disconnected'
      : 'timeout';
    if (peer.initiator && peer.attempt < PEER_MAX_ATTEMPTS &&
        peer.attempt !== PEER_PRIMARY_ATTEMPTS) {
      tracePeer(peer, 'peer.renegotiate.initiator', { nextAttempt: peer.attempt + 1 });
      peer.reason = '正在重新协商直连';
      renderPeers();
      void createPeer(peer.id, peer.name, true, peer.generation, peer.attempt + 1, true)
        .catch(err => { recordSignalError(err.message); feedback('重新协商失败', true); });
    } else if (peer.initiator && peer.attempt === PEER_PRIMARY_ATTEMPTS) {
      // After two normal attempts, let the original answerer offer.
      // Keep two bounded attempts for each direction rather than waiting for
      // three failures to try the path already seen working on real devices.
      tracePeer(peer, 'peer.renegotiate.reverse-role.request');
      void createPeer(peer.id, peer.name, false, peer.generation, PEER_PRIMARY_ATTEMPTS + 1, true)
        .then(next => {
          if (!next || state.peers.get(peer.id) !== next) return;
          next.reason = '正在尝试由对端发起直连';
          sendSignal(next.id, { type: 'retry', attempt: PEER_PRIMARY_ATTEMPTS + 1 });
          renderPeers();
        })
        .catch(err => { recordSignalError(err.message); feedback('反向协商失败', true); });
    } else if (!peer.initiator && peer.attempt > 0 &&
               peer.attempt < PEER_MAX_ATTEMPTS &&
               peer.attempt !== PEER_PRIMARY_ATTEMPTS &&
               peer.retryRequests < 1) {
      peer.retryRequests += 1;
      tracePeer(peer, 'peer.renegotiate.responder.request');
      peer.reason = '已请求对方重新协商';
      sendSignal(peer.id, { type: 'retry', attempt: peer.attempt });
      schedulePeerTimeout(peer);
      renderPeers();
    } else {
      peer.exhaustedAt ??= Date.now();
      peer.reason = '直连多次尝试未成功：请检查设备网络或防火墙';
      renderPeers();
    }
  }, delay);
}
async function createPeer(id, name, initiator, generation, attempt = initiator ? 1 : 0, force = false) {
  if (!generation) return null;
  const previous = state.peers.get(id);
  if (previous?.generation === generation && !force) return previous;
  // Preserve timing across ICE retries, but start a new measurement after a
  // previously successful connection has to be rebuilt.
  const sameUnreadySequence = previous?.generation === generation && !previous.readyAt;
  const firstAttemptStartedAt = sameUnreadySequence
    ? (previous.firstAttemptStartedAt ?? previous.startedAt ?? Date.now()) : Date.now();
  const attemptHistory = sameUnreadySequence
    ? [...(previous.attemptHistory || []),
        ...(previous.attempt > 0 ? [iceAttemptSnapshot(previous, 'replaced')] : [])].slice(-3)
    : [];
  if (previous) dropPeer(id, previous.generation);
  const pc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all' });
  const peer = { id, name, generation, initiator, attempt, retryRequests: 0,
    pc, channel: null, verified: false, remoteReady: false, remoteHostPairVerified: false, localReadySent: false,
    readyRetryAttempts: 0, readyRetriesSent: 0, readyEchoesSent: 0, readyEchoAnswered: false,
    ready: false, reason: '正在建立连接', candidates: [], sending: new Map(), syncedOffers: new Set(),
    catalogRequested: false, catalogReplayDone: false,
    catalogRefreshSeq: 0, lastCatalogRefreshSeq: 0, recoveryCheckInFlight: false,
    routeInfo: null,
    stage: initiator ? 'preparing-offer' : 'waiting-offer', localSdpSent: false,
    localCandidates: [], candidateCount: 0, acceptedCandidates: 0, rejectedCandidates: 0,
    startedAt: Date.now(), firstAttemptStartedAt, readyAt: null, connectTimer: null,
    attemptHistory, retryTrigger: null, exhaustedAt: null };
  state.peers.set(id, peer);
  tracePeer(peer, 'peer.created', { force, previousAttempt: previous?.attempt });
  pc.onsignalingstatechange = () => tracePeer(peer, 'webrtc.signalingstatechange');
  pc.onicegatheringstatechange = () => tracePeer(peer, 'webrtc.icegatheringstatechange');
  pc.onicecandidateerror = event => tracePeer(peer, 'webrtc.icecandidateerror', {
    address: event.address, port: event.port, url: event.url,
    errorCode: event.errorCode, errorText: event.errorText,
  });
  // A stuck ICE negotiation must actually create a fresh connection attempt,
  // rather than only replacing the text with a timeout warning.
  schedulePeerTimeout(peer);
  pc.onicecandidate = event => {
    tracePeer(peer, 'webrtc.icecandidate', {
      candidate: event.candidate?.toJSON?.() ?? null,
    });
    if (!event.candidate || state.peers.get(id) !== peer) return;
    const candidate = event.candidate.toJSON();
    // Only private-path host candidates and ICE end-of-candidates signaling.
    // No STUN/TURN; selected host candidates still pass the restricted P2P policy.
    if (candidate.candidate !== '' && !isHostCandidateLine(candidate.candidate)) {
      tracePeer(peer, 'webrtc.candidate.filtered', { candidate });
      return;
    }
    if (candidate.candidate !== '') peer.candidateCount += 1;
    // A candidate can be emitted during setLocalDescription, before SDP is sent.
    // Buffer locally until offer/answer has been delivered in signaling order.
    if (peer.localSdpSent) sendSignal(id, { type: 'candidate', attempt: peer.attempt, candidate });
    else peer.localCandidates.push(candidate);
  };
  pc.onconnectionstatechange = () => {
    tracePeer(peer, 'webrtc.connectionstatechange');
    void traceStats(peer, 'webrtc.connectionstatechange.stats');
    if (state.peers.get(id) !== peer) return;
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      peer.ready = false;
      peer.reason = `连接状态：${pc.connectionState}`;
      if (state.active?.peerId === id) failActive('设备连接中断');
      if (pc.connectionState !== 'closed') schedulePeerTimeout(peer, 5000);
    } else if (pc.connectionState === 'connected' && !peer.ready) {
      peer.reason = '正在检查 P2P 连接';
      void restorePeerAfterTransientDisconnect(peer);
    }
    renderPeers();
  };
  pc.oniceconnectionstatechange = () => {
    tracePeer(peer, 'webrtc.iceconnectionstatechange');
    void traceStats(peer, 'webrtc.iceconnectionstatechange.stats');
    if (state.peers.get(id) !== peer) return;
    if (pc.iceConnectionState === 'failed') {
      peer.ready = false;
      peer.reason = 'ICE 检查失败，准备重新协商';
      schedulePeerTimeout(peer, 2500);
    } else if (['connected', 'completed'].includes(pc.iceConnectionState) &&
               pc.connectionState === 'connected' && !peer.ready) {
      void restorePeerAfterTransientDisconnect(peer);
    }
    renderPeers();
  };
  pc.ondatachannel = event => {
    tracePeer(peer, 'webrtc.datachannel.created', { label: event.channel.label });
    attachChannel(peer, event.channel);
  };
  if (initiator) {
    attachChannel(peer, pc.createDataChannel('room-files', { ordered: true }));
    tracePeer(peer, 'webrtc.createOffer.start');
    const offer = await pc.createOffer();
    tracePeer(peer, 'webrtc.createOffer.done', { offer });
    await pc.setLocalDescription(offer);
    tracePeer(peer, 'webrtc.setLocalDescription.done', { localDescription: pc.localDescription });
    sendLocalDescription(peer, 'offer');
  }
  return peer;
}

function sendLocalDescription(peer, type) {
  tracePeer(peer, 'webrtc.sendLocalDescription', { type, localDescription: peer.pc.localDescription,
    queuedCandidates: peer.localCandidates });
  if (state.peers.get(peer.id) !== peer) return;
  sendSignal(peer.id, { type, attempt: peer.attempt, sdp: peer.pc.localDescription.sdp });
  peer.stage = `${type}-sent`;
  peer.localSdpSent = true;
  for (const candidate of peer.localCandidates.splice(0)) {
    sendSignal(peer.id, { type: 'candidate', attempt: peer.attempt, candidate });
  }
}
async function handleSignal(id, fromGeneration, signal) {
  trace('webrtc.handleSignal', { from: id, fromGeneration, signal });
  if (!signal || !['offer', 'answer', 'candidate', 'retry'].includes(signal.type) ||
      !Number.isInteger(signal.attempt) || signal.attempt < 0 ||
      signal.attempt > PEER_MAX_ATTEMPTS) return;
  // Both the member generation and the ICE attempt must match. Old trickled
  // candidates cannot affect a newly constructed RTCPeerConnection.
  let peer = state.peers.get(id);
  if (!peer || peer.generation !== fromGeneration) {
    trace('webrtc.signal.ignored.generation', { from: id, fromGeneration,
      knownGeneration: peer?.generation, signal });
    return;
  }
  if (signal.type === 'retry') {
    if (!peer.initiator && !peer.ready && signal.attempt === PEER_PRIMARY_ATTEMPTS + 1 &&
        peer.attempt === PEER_PRIMARY_ATTEMPTS &&
        !(peer.channel?.readyState === 'open' && peer.pc.connectionState === 'connected')) {
      // Original answerer becomes offerer only on the explicit role-swap.
      tracePeer(peer, 'peer.renegotiate.reverse-role.accept');
      await createPeer(id, peer.name, true, peer.generation, PEER_PRIMARY_ATTEMPTS + 1, true);
    } else if (peer.initiator && !peer.ready && signal.attempt === peer.attempt &&
               !(peer.channel?.readyState === 'open' && peer.pc.connectionState === 'connected') &&
               peer.attempt < PEER_MAX_ATTEMPTS &&
               peer.attempt !== PEER_PRIMARY_ATTEMPTS) {
      await createPeer(id, peer.name, true, peer.generation, peer.attempt + 1, true);
    }
    return;
  }
  if (signal.type === 'offer') {
    if (peer.initiator || signal.attempt < 1 || signal.attempt < peer.attempt) return;
    if (signal.attempt > peer.attempt) {
      if (peer.attempt === 0 && !peer.pc.remoteDescription) {
        peer.attempt = signal.attempt;
      } else {
        peer = await createPeer(id, peer.name, false, peer.generation, signal.attempt, true);
      }
    } else if (peer.pc.remoteDescription) {
      return; // duplicate offer for the current attempt
    }
    peer.stage = 'offer-received';
    tracePeer(peer, 'webrtc.setRemoteDescription.offer.start', { sdp: signal.sdp });
    await peer.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    tracePeer(peer, 'webrtc.setRemoteDescription.offer.done', { remoteDescription: peer.pc.remoteDescription });
    await flushCandidates(peer);
    const answer = await peer.pc.createAnswer();
    tracePeer(peer, 'webrtc.createAnswer.done', { answer });
    await peer.pc.setLocalDescription(answer);
    tracePeer(peer, 'webrtc.setLocalDescription.answer.done', { localDescription: peer.pc.localDescription });
    sendLocalDescription(peer, 'answer');
  } else if (signal.attempt === peer.attempt && signal.type === 'answer') {
    if (!peer.initiator || peer.pc.remoteDescription) return;
    peer.stage = 'answer-received';
    tracePeer(peer, 'webrtc.setRemoteDescription.answer.start', { sdp: signal.sdp });
    await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    tracePeer(peer, 'webrtc.setRemoteDescription.answer.done', { remoteDescription: peer.pc.remoteDescription });
    await flushCandidates(peer);
  } else if (signal.attempt === peer.attempt && signal.candidate &&
             typeof signal.candidate.candidate === 'string' &&
             (signal.candidate.candidate === '' || isHostCandidateLine(signal.candidate.candidate))) {
    if (signal.candidate.candidate !== '') peer.remoteCandidateCount = (peer.remoteCandidateCount || 0) + 1;
    if (peer.pc.remoteDescription) {
      await addRemoteCandidate(peer, signal.candidate, 'webrtc.addIceCandidate.done');
    } else {
      tracePeer(peer, 'webrtc.addIceCandidate.queued', { candidate: signal.candidate });
      peer.candidates.push(signal.candidate);
    }
  }
}
async function addRemoteCandidate(peer, candidate, eventName) {
  try {
    await peer.pc.addIceCandidate(candidate);
    if (candidate.candidate) peer.acceptedCandidates += 1;
    tracePeer(peer, eventName, { candidate });
  } catch (err) {
    peer.rejectedCandidates += 1;
    tracePeer(peer, 'webrtc.addIceCandidate.failed', { candidate, error: String(err) });
    throw err;
  }
}
async function flushCandidates(peer) {
  for (const candidate of peer.candidates.splice(0)) {
    await addRemoteCandidate(peer, candidate, 'webrtc.addIceCandidate.flushed');
  }
}

function inspectPeerPath(peer) {
  return inspectSelectedPath(peer.pc, {
    remoteReady: peer.remoteReady,
    remoteHostPairVerified: peer.remoteHostPairVerified,
    channelOpen: peer.channel?.readyState === 'open',
  });
}
// A transient RTC disconnect revokes transfer readiness. A healthy transport
// alone cannot restore it: re-attest the CURRENT selected path first, then
// refresh both catalogs because file-list controls may have been dropped while
// either endpoint was temporarily not ready. No ICE renegotiation or file bytes.
async function restorePeerAfterTransientDisconnect(peer) {
  const eligible = () => state.peers.get(peer.id) === peer && !peer.ready &&
    peer.readyAt !== null && peer.verified && peer.localReadySent && peer.remoteReady &&
    peer.channel?.readyState === 'open' && peer.pc.connectionState === 'connected' &&
    ['connected', 'completed'].includes(peer.pc.iceConnectionState);
  if (!eligible() || peer.recoveryCheckInFlight) return;
  peer.recoveryCheckInFlight = true;
  try {
    let verdict;
    try { verdict = await inspectPeerPath(peer); }
    catch { verdict = { allowed: false, reason: '当前路径检查失败', code: 'stats-error' }; }
    if (!eligible()) return;
    if (!verdict?.allowed) {
      peer.reason = `拒绝传输：${verdict?.reason || '当前路径未通过安全验证'}`;
      renderPeers();
      return;
    }
    peer.routeInfo = {
      code: verdict.code ?? 'unknown',
      localAddressKind: verdict.localAddressKind ?? 'unavailable',
      remoteAddressKind: verdict.remoteAddressKind ?? 'unavailable',
      localCandidateType: verdict.localCandidateType ?? 'unavailable',
      remoteCandidateType: verdict.remoteCandidateType ?? 'unavailable',
    };
    peer.ready = true;
    peer.reason = '文件直连就绪';
    clearTimeout(peer.connectTimer);
    // Metadata is safe to replay on a freshly re-verified P2P connection.
    // Recipients deduplicate by offerId; refresh requests are sequenced.
    peer.syncedOffers.clear();
    syncSharedOffers(peer);
    requestSharedOffers(peer, true);
    renderPeers();
  } finally {
    peer.recoveryCheckInFlight = false;
  }
}
async function verifyPeerPath(peer) {
  let verdict;
  try { verdict = await inspectPeerPath(peer); }
  catch (err) { verdict = { allowed: false, reason: `路径检查失败：${err.message}` }; }
  if (state.peers.get(peer.id) !== peer || peer.channel?.readyState !== 'open') return false;
  if (peer.verified) return true;
  tracePeer(peer, 'webrtc.route.verdict', { verdict });
  peer.reason = verdict.reason;
  peer.routeInfo = {
    code: verdict.code ?? 'stats-error',
    localAddressKind: verdict.localAddressKind ?? 'unavailable',
    remoteAddressKind: verdict.remoteAddressKind ?? 'unavailable',
    localCandidateType: verdict.localCandidateType ?? 'unavailable',
    remoteCandidateType: verdict.remoteCandidateType ?? 'unavailable',
  };
  if (verdict.allowed) {
    peer.verified = true;
    tracePeer(peer, 'datachannel.send.ready');
    // The limited masked host/prflx exception requires a verified host/host
    // declaration; legacy ready packets never qualify for that exception.
    peer.channel.send(JSON.stringify(verdict.hostHostVerified
      ? { kind: 'ready', hostHostVerified: true } : { kind: 'ready' }));
    peer.localReadySent = true;
    peer.ready = peer.remoteReady;
    peer.reason = peer.ready ? '文件直连就绪' : '文件通道已打开，等待对端完成安全路径验证';
    if (peer.ready) {
      peer.readyAt ??= Date.now();
      clearTimeout(peer.connectTimer);
    }
    syncSharedOffers(peer);
    requestSharedOffers(peer);
  }
  renderPeers();
  return peer.verified;
}
// A ready packet is only reannounced over the existing DataChannel after
// freshly verifying the currently selected P2P path. It never unlocks a file
// transfer; the opposite endpoint must still supply its own ready packet.
async function reannounceVerifiedReady(peer, requestReciprocal) {
  if (state.peers.get(peer.id) !== peer || !peer.verified || !peer.localReadySent ||
      peer.channel?.readyState !== 'open' || peer.pc.connectionState !== 'connected' ||
      peer.pc.iceConnectionState === 'failed' || (requestReciprocal && peer.remoteReady)) return false;
  let verdict;
  try { verdict = await inspectPeerPath(peer); }
  catch { return false; }
  if (!verdict?.allowed || state.peers.get(peer.id) !== peer ||
      peer.channel?.readyState !== 'open' || peer.pc.connectionState !== 'connected' ||
      peer.pc.iceConnectionState === 'failed' || (requestReciprocal && peer.remoteReady)) return false;
  try {
    peer.channel.send(JSON.stringify({
      kind: 'ready',
      ...(verdict.hostHostVerified ? { hostHostVerified: true } : {}),
      ...(requestReciprocal ? { requestReciprocal: true } : {}),
    }));
    if (requestReciprocal) peer.readyRetriesSent += 1;
    else peer.readyEchoesSent += 1;
    tracePeer(peer, 'datachannel.ready.reannounced', { requestReciprocal });
    return true;
  } catch (err) {
    tracePeer(peer, 'datachannel.ready.reannounce.failed', { error: String(err) });
    return false;
  }
}
function attachChannel(peer, channel) {
  peer.channel = channel;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 128 * 1024;
  channel.onmessage = event => {
    if (state.peers.get(peer.id) === peer) receiveChannel(peer, event.data);
  };
  tracePeer(peer, 'datachannel.attached', { label: channel.label, ordered: channel.ordered });
  channel.onclose = () => {
    tracePeer(peer, 'datachannel.close');
    if (state.peers.get(peer.id) !== peer) return;
    peer.ready = false; peer.reason = '文件通道已断开';
    schedulePeerTimeout(peer, 5000); renderPeers();
  };
  channel.onerror = event => {
    tracePeer(peer, 'datachannel.error', { eventType: event?.type });
    if (state.peers.get(peer.id) !== peer) return;
    peer.ready = false; peer.reason = '文件通道错误';
    schedulePeerTimeout(peer, 5000); renderPeers();
  };
  channel.onopen = async () => {
    tracePeer(peer, 'datachannel.open');
    void traceStats(peer, 'datachannel.open.stats');
    if (state.peers.get(peer.id) !== peer) return;
    for (let count = 0; count < 20 && channel.readyState === 'open' &&
         state.peers.get(peer.id) === peer; count += 1) {
      if (await verifyPeerPath(peer)) return;
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    if (state.peers.get(peer.id) !== peer || peer.verified) return;
    peer.reason = `拒绝传输：${peer.reason}`;
    peer.ready = false;
    renderPeers();
  };
}

async function receiveChannel(peer, data) {
  if (typeof data !== 'string') {
    handleBinary(peer, data);
    return;
  }
  let msg;
  try { msg = JSON.parse(data); }
  catch { return; }
  tracePeer(peer, 'datachannel.receive', { message: msg });
  if (TRANSFER_CONTROLS.has(msg.kind)) countTransfer(peer, msg.kind + ':received');
  if (msg.kind === 'ready') {
    // A duplicate remote ready cannot override a revoked local transfer gate.
    // Previously-ready links must re-attest the CURRENT selected path.
    const needsRecoveryCheck = peer.readyAt !== null && !peer.ready;
    peer.remoteReady = true;
    peer.remoteHostPairVerified = msg.hostHostVerified === true;
    peer.ready = peer.verified && !needsRecoveryCheck;
    if (peer.ready) peer.readyAt ??= Date.now();
    tracePeer(peer, 'datachannel.ready.received', {
      localReadySent: peer.localReadySent, localRouteVerified: peer.verified,
      remoteHostPairVerified: peer.remoteHostPairVerified,
    });
    // A host/prflx exception requires this peer's ready. Re-check immediately
    // even if the regular onopen polling window has already elapsed.
    if (!peer.verified && peer.channel?.readyState === 'open') {
      void verifyPeerPath(peer);
    } else if (needsRecoveryCheck) {
      void restorePeerAfterTransientDisconnect(peer);
    } else if (msg.requestReciprocal === true && peer.localReadySent &&
               !peer.readyEchoAnswered) {
      // A peer may have missed our initial ready. Reply at most once, after
      // freshly checking our selected path; never echo an echo.
      peer.readyEchoAnswered = true;
      void reannounceVerifiedReady(peer, false);
    }
    if (peer.ready) {
      peer.reason = '文件直连就绪';
      clearTimeout(peer.connectTimer);
    }
    syncSharedOffers(peer);
    requestSharedOffers(peer);
    renderPeers();
    return;
  }
  if (!peer.ready) {
    if (msg.kind === 'file-list') countTransfer(peer, 'catalog-ignored-unready');
    if (TRANSFER_CONTROLS.has(msg.kind)) countTransfer(peer, 'control-ignored-unready');
    return;
  }
  if (msg.kind === 'route-proof-request') {
    // Re-attest only the CURRENT selected host/host pair. The peer's earlier
    // ready message may predate ICE nomination; never echo cached approval.
    let hostHostVerified = false;
    try {
      const verdict = await inspectPeerPath(peer);
      hostHostVerified = verdict.allowed === true && verdict.hostHostVerified === true;
    } catch { /* A missing or unsafe selected path cannot be attested. */ }
    if (state.peers.get(peer.id) === peer && peer.ready) {
      sendPeer(peer, { kind: 'route-proof', hostHostVerified });
    }
  } else if (msg.kind === 'route-proof') {
    peer.remoteHostPairVerified = msg.hostHostVerified === true;
  } else if (msg.kind === 'qa-start') {
    // Only a locally armed QA page can react. This encrypted P2P control
    // carries no file selection, bytes, room credentials or signaling data.
    if (QA_MODE && msg.delayMs === QA_START_DELAY_MS) qaScheduleStart();
  } else if (msg.kind === 'file-list-request') {
    // The legacy first-ready request is replayed once. Subsequent requests
    // are permitted only with a strictly increasing per-peer recovery sequence.
    // Duplicate packets cannot repeatedly amplify catalog announcements.
    if (msg.refreshSeq !== undefined) {
      if (!Number.isSafeInteger(msg.refreshSeq) || msg.refreshSeq < 1 ||
          msg.refreshSeq <= peer.lastCatalogRefreshSeq) return;
      peer.lastCatalogRefreshSeq = msg.refreshSeq;
      countTransfer(peer, 'catalog-refresh-request:received');
    } else {
      if (peer.catalogReplayDone) return;
      peer.catalogReplayDone = true;
    }
    peer.syncedOffers.clear();
    syncSharedOffers(peer);
  } else if (msg.kind === 'file-list') {
    if (typeof msg.offerId !== 'string' || !Array.isArray(msg.files) || msg.files.length > MAX_FILES ||
        msg.files.some(f => typeof f.id !== 'string' || typeof f.name !== 'string' ||
          f.name.length > 255 || !Number.isSafeInteger(f.size) || f.size < 0)) return;
    const key = `${peer.id}:${msg.offerId}`;
    if (state.offers.has(key)) return;
    const offer = { peerId: peer.id, offerId: msg.offerId,
      files: msg.files.map(f => ({ id: f.id, name: f.name, size: f.size, status: 'pending' })) };
    state.offers.set(key, offer);
    renderRoomFiles();
    feedback(`${peerDisplayName(peer)} 分享了 ${msg.files.length} 个文件`);
    // Closing the previous transport tab loses its active DataChannel. Once
    // the new controller has re-established a verified P2P channel and the
    // original source reannounces its offer, restart pending transfers from
    // byte zero. Never pretend to resume a partial browser buffer.
    restartHandoffReceives(offer);
  } else if (msg.kind === 'file-withdraw') {
    if (typeof msg.offerId === 'string' && typeof msg.fileId === 'string') {
      withdrawPeerFile(peer.id, msg.offerId, msg.fileId);
    }
  } else if (msg.kind === 'request-file') {
    void startSendingFile(peer, msg);
  } else if (msg.kind === 'file-request-ack') {
    const job = state.active;
    if (job && job.peerId === peer.id && job.offerId === msg.offerId &&
        job.fileId === msg.fileId && job.status === '等待发送端') {
      job.status = '发送端已响应，等待文件启动';
      armJobTimer(job, 20000, '发送端已响应，但未开始发送');
      renderRoomFiles();
    }
  } else if (msg.kind === 'cancel-file') {
    const sending = peer.sending.get(msg.fileId);
    if (sending) sending.cancel();
    else sendPeer(peer, { kind: 'file-canceled', fileId: msg.fileId });
  } else if (msg.kind === 'file-start') {
    const job = state.active;
    if (!job || job.peerId !== peer.id || job.fileId !== msg.fileId || job.offerId !== msg.offerId || msg.size !== job.size) {
      countTransfer(peer, 'start-ignored-mismatch');
      return;
    }
    // A file-start already in transit must not undo a user's cancellation.
    if (job.cancelled) return;
    job.status = '传输中'; job.received = 0; job.chunks = [];
    armJobTimer(job, TRANSFER_IDLE_MS, '传输停滞超时'); renderRoomFiles();
  } else if (msg.kind === 'file-end') {
    const job = state.active;
    if (!job || job.peerId !== peer.id || job.fileId !== msg.fileId ||
        job.offerId !== msg.offerId) {
      countTransfer(peer, 'end-ignored');
      return;
    }
    // The sender may have completed before it received cancel-file. With an
    // ordered DataChannel, file-end safely terminates that cancelled stream.
    if (job.cancelled) { finishJob('已取消'); return; }
    if (job.status !== '传输中') {
      countTransfer(peer, 'end-ignored');
      return;
    }
    if (job.received !== job.size) {
      countTransfer(peer, 'end-size-mismatch');
      failActive('文件大小不匹配'); return;
    }
    if (!isSha256Hex(msg.sha256)) {
      countTransfer(peer, 'end-invalid-digest');
      failActive('发送端缺少有效校验值，请双方刷新后重试'); return;
    }
    job.status = '校验中';
    armJobTimer(job, TRANSFER_IDLE_MS, '文件校验超时');
    renderRoomFiles();
    try {
      const blob = new Blob(job.chunks);
      const verified = await verifySha256(blob, msg.sha256);
      if (state.active !== job || job.cancelled) return;
      if (!verified) {
        countTransfer(peer, 'end-checksum-mismatch');
        failActive('文件 SHA-256 校验失败，已丢弃数据'); return;
      }
      job.blob = blob;
      job.url = URL.createObjectURL(blob);
      job.chunks = [];
      broadcastRoomHandoff();
      countTransfer(peer, 'end-verified');
      finishJob('校验通过，点击保存');
    } catch (err) {
      if (state.active === job) {
        countTransfer(peer, 'end-checksum-error');
        failActive(`文件校验失败：${err.message}`);
      }
    }
  } else if (msg.kind === 'file-canceled') {
    const job = state.active;
    if (job?.peerId === peer.id && job.fileId === msg.fileId && job.cancelled) {
      finishJob('已取消');
    }
  } else if (msg.kind === 'file-error') {
    const job = state.active;
    if (job?.peerId === peer.id && job.fileId === msg.fileId) {
      if (job.cancelled) finishJob('已取消');
      else failActive(msg.message || '发送方读取失败');
    } else countTransfer(peer, 'error-ignored-mismatch');
  }
}
function handleBinary(peer, data) {
  const job = state.active;
  if (!peer.ready || !job || job.peerId !== peer.id || job.status !== '传输中' || !(data instanceof ArrayBuffer)) {
    if (data instanceof ArrayBuffer) countTransfer(peer, 'binary-ignored');
    return;
  }
  if (data.byteLength > CHUNK_SIZE || job.received + data.byteLength > job.size) { failActive('数据块超过允许大小'); return; }
  if (!job.cancelled) job.chunks.push(data);
  if (QA_MODE && data.byteLength > 0) {
    if (job.wireFirstByteAt === undefined) job.wireFirstByteAt = Date.now();
    job.wireLastByteAt = Date.now();
  }
  job.received += data.byteLength;
  armJobTimer(job, TRANSFER_IDLE_MS, '传输停滞超时');
  renderRoomFiles();
}

// During a transfer, a browser can briefly omit its selected ICE pair from
// getStats(). Pause all file bytes and re-check, but NEVER retry an explicit
// unsafe-route verdict or use a previous approval as permission to continue.
async function requireTransferPath(peer, token, phase) {
  const transient = new Set(['pair-unavailable', 'stats-unavailable', 'stats-error']);
  const safeKinds = new Set(['mdns', 'hidden', 'redacted', 'private-ipv4']);
  let code = 'stats-error';
  let proofRequested = false;
  for (let retry = 0; retry < 3; retry += 1) {
    if (token.cancelled) return false;
    if (!peer.ready || peer.channel?.readyState !== 'open' ||
        peer.pc.connectionState !== 'connected' ||
        !['connected', 'completed'].includes(peer.pc.iceConnectionState)) {
      throw new Error('设备直连状态已改变，已停止发送');
    }
    let verdict;
    try { verdict = await inspectPeerPath(peer); }
    catch { verdict = { allowed: false, code: 'stats-error' }; }
    if (token.cancelled) return false;
    if (!peer.ready || peer.channel?.readyState !== 'open' ||
        peer.pc.connectionState !== 'connected' ||
        !['connected', 'completed'].includes(peer.pc.iceConnectionState)) {
      throw new Error('设备直连状态已改变，已停止发送');
    }
    if (verdict.allowed) {
      if (retry > 0) countTransfer(peer, 'route-check-recovered');
      return true;
    }
    code = verdict.code || 'stats-error';
    peer.lastRouteCheckCode = code;
    peer.lastRouteCheckEvidence = verdict.reflexiveEvidence || null;
    // A selected host/prflx pair may be temporarily unverified while browser
    // stats settle or a reciprocal host/host attestation is being refreshed.
    // Recheck with bytes PAUSED; never treat an unsafe or unverified verdict
    // as permission to continue.
    const evidence = verdict.reflexiveEvidence;
    const safeReflexive = code === 'prflx-unverified' && evidence &&
      safeKinds.has(evidence.localAddressKind) && safeKinds.has(evidence.remoteAddressKind);
    if (safeReflexive && !proofRequested && !peer.remoteHostPairVerified) {
      proofRequested = sendPeer(peer, { kind: 'route-proof-request' });
    }
    if ((!transient.has(code) && !safeReflexive) || retry === 2) break;
    countTransfer(peer, 'route-check-retried');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  countTransfer(peer, 'route-check-failed');
  throw new Error(`${phase}路径检查失败（${code}）`);
}

async function startSendingFile(peer, request) {
  const offer = state.outbound.get(request.offerId);
  const file = offer?.get(request.fileId);
  tracePeer(peer, 'file.send.request', { request, fileName: file?.name,
    fileSize: file?.size });
  if (!file || !peer.ready) {
    countTransfer(peer, !file ? 'source-unavailable' : 'sender-not-ready');
    sendPeer(peer, { kind: 'file-error', fileId: request.fileId, message: '原文件已不可用，请重新选择发送' });
    return;
  }
  if (peer.sending.has(request.fileId)) {
    countTransfer(peer, 'duplicate-request-ignored');
    sendPeer(peer, { kind: 'file-error', fileId: request.fileId,
      message: '上一笔传输尚未结束，请稍后重试' });
    return;
  }
  const token = { cancelled: false, cancel() { this.cancelled = true; } };
  peer.sending.set(request.fileId, token);
  // Confirm that the sender received the request before checking browser
  // stats or reading the file; this separates signaling from sender stalls.
  if (!sendPeer(peer, { kind: 'file-request-ack', offerId: request.offerId, fileId: request.fileId })) {
    peer.sending.delete(request.fileId);
    return;
  }
  try {
    if (!await requireTransferPath(peer, token, '文件启动前')) {
      sendPeer(peer, { kind: 'file-canceled', fileId: request.fileId });
      return;
    }
    if (!sendPeer(peer, { kind: 'file-start', offerId: request.offerId, fileId: request.fileId, size: file.size })) throw new Error('设备连接断开');
    for (let offset = 0, block = 0; offset < file.size; offset += CHUNK_SIZE, block += 1) {
      if (token.cancelled) break;
      if (block % 16 === 0 && !await requireTransferPath(peer, token, '传输途中')) break;
      const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      while (peer.channel.bufferedAmount > 512 * 1024 && !token.cancelled) {
        if (peer.channel.readyState !== 'open') throw new Error('连接断开');
        await new Promise(resolve => setTimeout(resolve, 45));
      }
      if (!token.cancelled) peer.channel.send(chunk);
    }
    if (token.cancelled) {
      sendPeer(peer, { kind: 'file-canceled', fileId: request.fileId });
    } else {
      // The digest stays on the P2P channel; never sent to the public signalling server.
      const sha256 = await sha256Hex(file);
      if (token.cancelled) sendPeer(peer, { kind: 'file-canceled', fileId: request.fileId });
      else sendPeer(peer, { kind: 'file-end', offerId: request.offerId, fileId: request.fileId, sha256 });
    }
  } catch (err) {
    countTransfer(peer, 'sender-failed');
    sendPeer(peer, { kind: 'file-error', fileId: request.fileId, message: String(err.message).slice(0, 160) });
  } finally {
    peer.sending.delete(request.fileId);
  }
}

function suspendReceivesForSignalRecovery() {
  const queued = new Set(state.queue);
  for (const job of state.jobs) {
    if (state.active !== job && !queued.has(job) && !job.recovering) continue;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (job.handoffRetryTimer) clearTimeout(job.handoffRetryTimer);
    job.handoffRetryTimer = null;
    job.chunks = [];
    if (job.cancelled) {
      job.recovering = false;
      job.status = '已取消';
      continue;
    }
    if (job.url) continue; // Never invalidate a verified saved download.
    // An incomplete legacy/malformed queued task has no safe source to
    // match after reconnect; unlike valid tasks it remains a failure.
    const matchable = typeof job.offerId === 'string' &&
      typeof job.fileId === 'string' && typeof job.name === 'string' &&
      Number.isSafeInteger(job.size) && job.size >= 0;
    job.recovering = matchable;
    job.received = 0;
    job.status = matchable ? '等待连接恢复后重新接收' : '失败：连接已中断';
  }
  state.active = null;
  state.queue = [];
}
function restartHandoffReceives(offer) {
  const peer = state.peers.get(offer.peerId);
  if (!peer?.ready) return;
  let restored = 0;
  for (const job of state.jobs) {
    if (!job.recovering || job.cancelled || job.url ||
        job.offerId !== offer.offerId) continue;
    // File IDs are random per offer; also compare metadata so a new,
    // unrelated file can never silently replace the intended download.
    const file = offer.files.find(item => item.id === job.fileId &&
      item.name === job.name && item.size === job.size);
    if (!file || file.status !== 'pending') continue;
    job.peerId = offer.peerId;
    job.received = 0;
    job.chunks = [];
    job.cancelled = false;
    job.recovering = false;
    job.fromHandoff = true;
    job.handoffRetryCount = 0;
    job.status = '排队中';
    file.status = 'queued';
    state.queue.push(job);
    restored += 1;
  }
  if (restored) {
    feedback(`连接已恢复，正在重新接收 ${restored} 个未完成文件`);
    renderRoomFiles();
    startNext();
  }
}
function acceptFile(offer, file) {
  if (mirroredRoom) {
    if (file.status === 'pending') sendMirrorAction({
      kind: 'accept', peerId: offer.peerId, offerId: offer.offerId, fileId: file.id,
    });
    return;
  }
  if (file.status !== 'pending') return;
  file.status = 'queued';
  const job = { peerId: offer.peerId, offerId: offer.offerId, fileId: file.id,
    name: file.name, size: file.size, received: 0, chunks: [], status: '排队中', url: null, cancelled: false };
  state.jobs.push(job);
  state.queue.push(job);
  renderRoomFiles(); startNext();
}
function startNext() {
  if (state.active || state.queue.length === 0) return;
  const job = state.queue.shift();
  const peer = state.peers.get(job.peerId);
  if (!peer?.ready) {
    job.status = '失败：设备暂不可用'; renderRoomFiles(); startNext(); return;
  }
  state.active = job;
  job.status = '等待发送端';
  armJobTimer(job, 20000, '等待发送端超时');
  if (!sendPeer(peer, { kind: 'request-file', offerId: job.offerId, fileId: job.fileId })) {
    failActive('文件请求发送失败');
    return;
  }
  renderRoomFiles();
}
function armJobTimer(job, delay, reason) {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    if (state.active === job) failActive(reason);
  }, delay);
}
// A just-promoted receiver may ask for a file while its old sender task is
// still unwinding, or while a verified P2P path's stats are briefly settling.
// Retry only known transient failures, and always re-request the exact same
// announced file via the normal ready-gated P2P sender and SHA-256 checks.
function transientHandoffFailure(status) {
  return new Set([
    '失败：上一笔传输尚未结束，请稍后重试',
    '失败：等待发送端超时',
    '失败：发送端已响应，但未开始发送',
    '失败：传输停滞超时',
    '失败：文件请求发送失败',
    '失败：设备连接断开',
    '失败：连接断开',
    '失败：设备直连状态已改变，已停止发送',
  ]).has(status) ||
    /路径检查失败（(?:pair-unavailable|stats-unavailable|stats-error)）$/.test(status);
}
function scheduleHandoffRetry(job, status, file) {
  const attempt = job.handoffRetryCount || 0;
  const peer = state.peers.get(job.peerId);
  if (!job.fromHandoff || job.cancelled || job.url || !transientHandoffFailure(status) ||
      attempt >= HANDOFF_RECEIVE_RETRY_DELAYS_MS.length || !peer?.ready ||
      peer.channel?.readyState !== 'open' || !file ||
      file.name !== job.name || file.size !== job.size) return false;
  const delay = HANDOFF_RECEIVE_RETRY_DELAYS_MS[attempt];
  job.handoffRetryCount = attempt + 1;
  job.recovering = true;
  job.received = 0;
  job.chunks = [];
  job.status = `恢复传输受阻，${delay / 1000} 秒后自动重试（${attempt + 1}/${HANDOFF_RECEIVE_RETRY_DELAYS_MS.length}）`;
  file.status = 'queued';
  job.handoffRetryTimer = setTimeout(() => {
    job.handoffRetryTimer = null;
    if (state.leaving || !job.recovering || job.cancelled || job.url) return;
    const currentPeer = state.peers.get(job.peerId);
    const offer = state.offers.get(`${job.peerId}:${job.offerId}`);
    const currentFile = offer?.files.find(item => item.id === job.fileId &&
      item.name === job.name && item.size === job.size);
    if (!currentPeer?.ready || currentPeer.channel?.readyState !== 'open' ||
        !currentFile) {
      job.recovering = false;
      job.status = '失败：连接或文件来源已变化，请手动重试';
      if (currentFile) currentFile.status = 'failed';
      renderRoomFiles();
      return;
    }
    job.recovering = false;
    job.status = '排队中';
    currentFile.status = 'queued';
    state.queue.push(job);
    renderRoomFiles();
    startNext();
  }, delay);
  return true;
}
function finishJob(status) {
  const job = state.active;
  if (!job) return;
  if (job.timer) clearTimeout(job.timer);
  job.timer = null;
  const offer = state.offers.get(`${job.peerId}:${job.offerId}`);
  const file = offer?.files.find(f => f.id === job.fileId);
  if (scheduleHandoffRetry(job, status, file)) {
    state.active = null;
    renderRoomFiles();
    queueMicrotask(startNext);
    return;
  }
  job.status = status;
  if (file) file.status = status === '校验通过，点击保存' ? 'complete' : 'failed';
  job.chunks = [];
  state.active = null;
  renderRoomFiles();
  queueMicrotask(startNext);
}
function failActive(reason) { if (state.active) finishJob(`失败：${reason}`); }
function cancelJob(job) {
  if (mirroredRoom) {
    sendMirrorAction({ kind: 'cancel', peerId: job.peerId, offerId: job.offerId, fileId: job.fileId });
    return;
  }
  if (job.recovering) {
    if (job.handoffRetryTimer) clearTimeout(job.handoffRetryTimer);
    job.handoffRetryTimer = null;
    job.recovering = false;
    job.cancelled = true;
    job.status = '已取消';
    renderRoomFiles();
    return;
  }
  if (state.active === job) {
    if (job.cancelled) return;
    job.cancelled = true;
    job.chunks = [];
    if (job.status === '校验中') {
      // file-end has already arrived; no sender acknowledgement is needed.
      finishJob('已取消');
      return;
    }
    state.peers.get(job.peerId) && sendPeer(state.peers.get(job.peerId), { kind: 'cancel-file', fileId: job.fileId });
    job.status = '正在取消';
    renderRoomFiles();
  } else if (state.queue.includes(job)) {
    state.queue.splice(state.queue.indexOf(job), 1);
    job.status = '已取消';
    const offer = state.offers.get(`${job.peerId}:${job.offerId}`);
    const file = offer?.files.find(f => f.id === job.fileId);
    if (file) file.status = 'failed';
    renderRoomFiles();
  }
}
function retryJob(job) {
  if (mirroredRoom) {
    sendMirrorAction({ kind: 'retry', peerId: job.peerId, offerId: job.offerId, fileId: job.fileId });
    return;
  }
  if (!job.status.startsWith('失败') && job.status !== '已取消') return;
  const offer = state.offers.get(`${job.peerId}:${job.offerId}`);
  const file = offer?.files.find(f => f.id === job.fileId);
  if (!file) {
    job.status = '已撤回';
    feedback('该文件已被撤回，无法重试', true);
    renderRoomFiles();
    return;
  }
  job.received = 0; job.chunks = []; job.cancelled = false; job.status = '排队中';
  job.fromHandoff = false; // A manual retry is an independent user action.
  file.status = 'queued';
  state.queue.push(job); renderRoomFiles(); startNext();
}

// Deliberately opt-in diagnostic helper for one operator testing three devices.
// The selected remote file never leaves this browser; only an empty P2P start
// notice is sent on already verified peer channels. No cloud coordination.
function qaFileChoices() {
  if (!QA_MODE) return [];
  const choices = [];
  for (const [key, offer] of state.offers) {
    const peer = state.peers.get(offer.peerId);
    if (!peer?.ready) continue;
    for (const file of offer.files) {
      if (file.status === 'pending') {
        choices.push({ key: `${key}:${file.id}`, offer, file, peer });
      }
    }
  }
  return choices;
}
function qaArmedTarget() {
  if (!QA_MODE || !qaArmed || qaArmed.code !== state.code ||
      state.ws?.readyState !== WebSocket.OPEN || !state.generation ||
      state.active || state.queue.length) return null;
  const choice = qaFileChoices().find(item => item.key === qaArmed.key);
  return choice?.peer.generation === qaArmed.generation ? choice : null;
}
function qaRender() {
  if (!QA_MODE) return;
  const select = $('qa-file');
  const previous = select.value;
  const choices = qaFileChoices();
  select.replaceChildren();
  for (const item of choices) {
    const option = elem('option', '', `${peerDisplayName(item.peer)} · ${item.file.name} (${humanSize(item.file.size)})`);
    option.value = item.key;
    select.append(option);
  }
  select.value = choices.some(item => item.key === previous)
    ? previous : choices[0]?.key || '';
  select.disabled = Boolean(qaArmed) || qaTimer !== null || !choices.length;
  $('qa-arm').disabled = !choices.length || Boolean(qaArmed) ||
    qaTimer !== null || Boolean(state.active) || state.queue.length > 0;
  $('qa-start').disabled = !qaArmedTarget() || qaTimer !== null ||
    state.peers.size < 2 || [...state.peers.values()].some(peer => !peer.ready);
  $('qa-cancel').disabled = !qaArmed && qaTimer === null;
}
function qaArmSelected() {
  if (!QA_MODE || qaTimer !== null || qaArmed) return false;
  const item = qaFileChoices().find(choice => choice.key === $('qa-file').value);
  if (!item || state.active || state.queue.length || !state.generation) {
    $('qa-status').textContent = '当前没有可准备的文件或设备直连未就绪';
    return false;
  }
  qaArmed = { key: item.key, peerId: item.offer.peerId,
    generation: item.peer.generation, code: state.code };
  qaLastOutcome = '已准备';
  $('qa-status').textContent = '本机已准备接收。请继续准备另外两台设备，最后只在 A 点击“同步开始”。';
  qaRender();
  return true;
}
function qaCancelPlan() {
  if (!QA_MODE) return;
  if (qaTimer !== null) clearTimeout(qaTimer);
  qaTimer = null;
  qaArmed = null;
  qaLastOutcome = '已取消';
  $('qa-status').textContent = '已取消准备，不会自动接收文件';
  qaRender();
}
function qaScheduleStart() {
  if (!QA_MODE || qaTimer !== null || !qaArmedTarget()) return false;
  qaTriggerAt = Date.now();
  qaLastOutcome = '倒计时';
  qaTimer = setTimeout(() => {
    qaTimer = null;
    const item = qaArmedTarget();
    qaArmed = null;
    if (!item) {
      qaLastOutcome = '已跳过：文件或连接不再可用';
      $('qa-status').textContent = '目标文件或安全连接已改变，没有自动开始传输';
      qaRender();
      return;
    }
    // Use the same normal receive queue, sender path gate and SHA-256 logic.
    acceptFile(item.offer, item.file);
    const job = state.jobs.at(-1);
    if (job && job.offerId === item.offer.offerId && job.fileId === item.file.id) {
      job.qaTriggerAt = qaTriggerAt;
    }
    qaLastOutcome = '已发起接收';
    $('qa-status').textContent = '已同时发起接收；进度在下方房间文件列表，结束后复制普通诊断。';
    qaRender();
  }, QA_START_DELAY_MS);
  $('qa-status').textContent = '已收到同步开始通知，6 秒后自动发起接收。请保持页面前台。';
  qaRender();
  return true;
}
function qaStartAll() {
  if (!QA_MODE || qaTimer !== null || !qaArmedTarget()) return false;
  const peers = [...state.peers.values()];
  if (peers.length < 2 || peers.some(peer => !peer.ready ||
      peer.channel?.readyState !== 'open')) {
    $('qa-status').textContent = '需要三台设备都进入房间且直连就绪';
    qaRender();
    return false;
  }
  // A single click on the coordinator sends a tiny notice over its already
  // verified P2P links. An unarmed/normal client will always ignore it.
  const sent = peers.every(peer => sendPeer(peer, {
    kind: 'qa-start', delayMs: QA_START_DELAY_MS,
  }));
  if (!sent) {
    $('qa-status').textContent = '部分同步通知未发出，本轮结果无效；请检查三台设备连接';
    return false;
  }
  return qaScheduleStart();
}

// Each receiver asks for the current file catalog once it has independently
// verified the P2P link. Early announcements may have been ignored before then.
function requestSharedOffers(peer, refresh = false) {
  if (!peer?.ready || (peer.catalogRequested && !refresh)) return;
  const nextSeq = peer.catalogRefreshSeq + 1;
  const request = refresh
    ? { kind: 'file-list-request', refreshSeq: nextSeq }
    : { kind: 'file-list-request' };
  if (sendPeer(peer, request)) {
    peer.catalogRequested = true;
    if (refresh) {
      peer.catalogRefreshSeq = nextSeq;
      countTransfer(peer, 'catalog-refresh-request:sent');
    }
  }
}
// File objects remain in the uploader's browser; the signalling server stores none.
// Each verified peer gets the current room file catalog, including later joiners.
function syncSharedOffers(peer) {
  if (!peer?.ready) return;
  for (const offer of state.ownOffers) {
    if (peer.syncedOffers.has(offer.offerId)) continue;
    if (sendPeer(peer, { kind: 'file-list', offerId: offer.offerId, files: offer.files })) {
      peer.syncedOffers.add(offer.offerId);
    }
  }
}
function shareFiles(files, ownerTabId = localRoomTabId) {
  if (mirroredRoom) {
    if (files.length) sendMirrorAction({ kind: 'share', files });
    return;
  }
  if (!state.code) { feedback('请先进入房间', true); return; }
  if (!files.length || files.length > MAX_FILES) { feedback('一次请选择 1–20 个文件', true); return; }
  if (files.some(file => !Number.isSafeInteger(file.size) || file.size < 0)) {
    feedback('文件大小无效', true); return;
  }
  const offerId = crypto.randomUUID();
  const fileMap = new Map();
  trace('file.share.selection', { files: files.map(file => ({
    name: file.name, size: file.size, type: file.type, lastModified: file.lastModified,
  })) });
  const metadata = files.map(file => {
    const id = crypto.randomUUID(); fileMap.set(id, file);
    return { id, name: file.name, size: file.size };
  });
  state.outbound.set(offerId, fileMap);
  // Remember the selecting tab for diagnostics, not as file lifetime ownership.
  state.ownOffers.push({ offerId, ownerTabId, files: metadata });
  broadcastRoomHandoff();
  for (const peer of state.peers.values()) syncSharedOffers(peer);
  renderSentFiles();
  const ready = [...state.peers.values()].filter(peer => peer.ready).length;
  feedback(files.some(file => file.size > LARGE_FILE_WARNING_BYTES)
    ? '大文件已加入共享列表；实验性传输可能因浏览器内存不足而失败'
    : ready ? '文件已加入房间共享列表' : '文件已添加，等待设备直连');
}
function withdrawSharedFile(offerId, fileId) {
  if (mirroredRoom) {
    sendMirrorAction({ kind: 'withdraw', offerId, fileId });
    return;
  }
  const offer = state.ownOffers.find(item => item.offerId === offerId);
  if (!offer || !offer.files.some(file => file.id === fileId)) return;
  offer.files = offer.files.filter(file => file.id !== fileId);
  const fileMap = state.outbound.get(offerId);
  fileMap?.delete(fileId);
  for (const peer of state.peers.values()) {
    peer.sending.get(fileId)?.cancel();
    sendPeer(peer, { kind: 'file-withdraw', offerId, fileId });
  }
  if (!offer.files.length) {
    state.ownOffers = state.ownOffers.filter(item => item !== offer);
    state.outbound.delete(offerId);
  }
  broadcastRoomHandoff();
  renderSentFiles();
}
function withdrawPeerFile(peerId, offerId, fileId) {
  const key = `${peerId}:${offerId}`;
  const offer = state.offers.get(key);
  if (!offer) return;
  offer.files = offer.files.filter(file => file.id !== fileId);
  if (!offer.files.length) state.offers.delete(key);
  if (state.active?.peerId === peerId && state.active?.fileId === fileId) finishJob('已撤回');
  for (const job of state.jobs) {
    if (job.peerId === peerId && job.offerId === offerId && job.fileId === fileId && !job.url) {
      if (job.handoffRetryTimer) clearTimeout(job.handoffRetryTimer);
      job.handoffRetryTimer = null;
      job.recovering = false;
      job.status = '已撤回';
    }
  }
  state.queue = state.queue.filter(job => !(job.peerId === peerId && job.offerId === offerId && job.fileId === fileId));
  renderRoomFiles();
}
function discardPeerOffers(peerId) {
  for (const [key, offer] of state.offers) {
    if (offer.peerId === peerId) state.offers.delete(key);
  }
  for (const job of state.queue.filter(job => job.peerId === peerId)) job.status = '发送设备已离线';
  state.queue = state.queue.filter(job => job.peerId !== peerId);
}
function peerDisplayName(peer) {
  const sameName = (deviceName() === peer.name ? 1 : 0) +
    [...state.peers.values()].filter(other => other.name === peer.name).length;
  // Names are editable labels, not unique IDs. Use a short, stable session
  // discriminator only when the same name is shown more than once.
  return sameName > 1 ? `${peer.name} · ${peer.id.slice(-4)}` : peer.name;
}
function renderPeers() {
  scheduleRoomView();
  const list = $('peer-list');
  list.replaceChildren();
  const peers = [...state.peers.values()];
  $('device-count').textContent = `${peers.length} 台 · ${peers.filter(p => p.ready).length} 可传`;
  if (!peers.length) list.append(elem('p', 'empty', '暂无其他设备'));
  for (const peer of peers) {
    const row = elem('div', 'device-row');
    row.append(elem('div', 'device-icon', deviceAvatar(peer.name)));
    const info = elem('div', 'item-info');
    info.append(elem('strong', '', peerDisplayName(peer)), elem('span', '', peer.ready ? '已连接' : peer.reason));
    row.append(info);
    list.append(row);
  }
  updateConnectionSummary();
  renderDiagnostics();
  renderSentFiles();
  qaRender();
}
// Ordinary diagnostics never echo a sender-supplied error string or file
// metadata. Use fixed codes to distinguish post-file-end failure stages.
function receiveFailureCode(job) {
  const status = String(job.status || '');
  if (!status.startsWith('失败')) return null;
  if (status.includes('文件大小不匹配')) return 'size-mismatch';
  if (status.includes('文件 SHA-256 校验失败')) return 'checksum-mismatch';
  if (status.includes('发送端缺少有效校验值')) return 'invalid-digest';
  if (status.includes('文件校验超时')) return 'checksum-timeout';
  if (status.includes('文件校验失败')) return 'checksum-error';
  if (status.includes('传输停滞超时')) return 'transfer-timeout';
  if (status.includes('等待发送端超时')) return 'sender-timeout';
  if (status.includes('上一笔传输尚未结束')) return 'sender-busy';
  return 'other-failure';
}
function receiveJobOutcome(job) {
  const status = String(job.status || '');
  const failure = receiveFailureCode(job);
  return {
    phase: job.url ? 'verified' : failure ? 'failed'
      : job.cancelled ? 'cancelled' : job.recovering ? 'recovering'
      : status === '校验中' ? 'checking'
      : status === '传输中' ? 'receiving' : 'waiting',
    failure,
    receivedAllBytes: job.received === job.size,
    saveReady: Boolean(job.url),
    autoRetries: job.handoffRetryCount || 0,
  };
}
function diagnosticsSnapshot() {
  if (mirroredRoom?.view?.diagnostics) {
    return mirrorActionsUnavailable()
      ? { ...mirroredRoom.view.diagnostics, signal: 'unknown' }
      : mirroredRoom.view.diagnostics;
  }
  return {
    signal: state.ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
    signalErrors: state.signalErrors,
    lastSignalError: state.lastSignalError,
    signalKeepalive: {
      sent: signalHealth.sent, acksReceived: signalHealth.acksReceived,
      timeouts: signalHealth.timeouts, pending: signalKeepalivePending !== null,
      disconnects: signalHealth.disconnects, reconnectsScheduled: signalHealth.reconnectsScheduled,
      lastDisconnect: signalHealth.lastDisconnect,
    },
    peerCount: state.peers.size,
    roomEntry: state.lastRoomEntry,
    signalHistory: signalHistory.slice(),
    localSharedFiles: state.ownOffers.reduce((n, offer) => n + offer.files.length, 0),
    visibleRemoteFiles: [...state.offers.values()].reduce((n, offer) => n + offer.files.length, 0),
    receive: {
      totalJobs: state.jobs.length,
      recent: state.jobs.slice(-3).map(receiveJobOutcome),
    },
    ...(QA_MODE ? { qa: {
      enabled: true, armed: Boolean(qaArmed), countdownPending: qaTimer !== null,
      triggered: qaTriggerAt !== null, lastOutcome: qaLastOutcome,
      // Relative time to the locally received P2P start notification;
      // filename, member ID, room code and address are intentionally omitted.
      receiveWindows: state.jobs.filter(job => job.qaTriggerAt !== undefined).slice(-6).map(job => ({
        sizeBytes: job.size, status: job.status,
        firstByteAfterTriggerMs: job.wireFirstByteAt === undefined ? null
          : job.wireFirstByteAt - job.qaTriggerAt,
        lastByteAfterTriggerMs: job.wireLastByteAt === undefined ? null
          : job.wireLastByteAt - job.qaTriggerAt,
      })),
    }} : {}),
    peers: [...state.peers.values()].map((peer, index) => ({
      device: index + 1,
      connection: peer.pc?.connectionState ?? 'unknown',
      ice: peer.pc?.iceConnectionState ?? 'unknown',
      channel: peer.channel?.readyState ?? 'none',
      routeVerified: Boolean(peer.verified),
      localReadySent: Boolean(peer.localReadySent),
      peerVerified: Boolean(peer.remoteReady),
      readyRetryAttempts: peer.readyRetryAttempts || 0,
      readyRetriesSent: peer.readyRetriesSent || 0,
      readyEchoesSent: peer.readyEchoesSent || 0,
      remoteHostPairVerified: Boolean(peer.remoteHostPairVerified),
      route: peer.routeInfo,
      stage: peer.stage || 'unknown',
      attempt: peer.attempt,
      signalingState: peer.pc?.signalingState ?? 'unknown',
      iceGathering: peer.pc?.iceGatheringState ?? 'unknown',
      localDescriptionSet: Boolean(peer.pc?.localDescription),
      remoteDescriptionSet: Boolean(peer.pc?.remoteDescription),
      elapsedSeconds: Math.floor((Date.now() - (peer.startedAt ?? Date.now())) / 1000),
      // From the first RTC peer attempt to P2P-ready; unlike elapsedSeconds,
      // this includes ICE retries and freezes when the handshake completes.
      setupElapsedSeconds: Math.max(0, Math.round(
        ((peer.readyAt ?? Date.now()) - (peer.firstAttemptStartedAt ?? peer.startedAt ?? Date.now())) / 1000)),
      timeToReadySeconds: peer.readyAt === null || peer.readyAt === undefined ? null
        : Math.max(0, Math.round((peer.readyAt - peer.firstAttemptStartedAt) / 1000)),
      iceAttempts: [...peer.attemptHistory, iceAttemptSnapshot(peer,
        peer.ready ? 'ready' : peer.exhaustedAt ? 'exhausted' : 'in-progress')],
      candidatesSent: peer.candidateCount || 0,
      candidatesReceived: peer.remoteCandidateCount || 0,
      canTransfer: Boolean(peer.ready),
      transfer: {
        requestsSent: peer.transferEvents?.['request-file:sent'] || 0,
        requestsReceived: peer.transferEvents?.['request-file:received'] || 0,
        acksSent: peer.transferEvents?.['file-request-ack:sent'] || 0,
        acksReceived: peer.transferEvents?.['file-request-ack:received'] || 0,
        startsSent: peer.transferEvents?.['file-start:sent'] || 0,
        startsReceived: peer.transferEvents?.['file-start:received'] || 0,
        errorsSent: peer.transferEvents?.['file-error:sent'] || 0,
        errorsReceived: peer.transferEvents?.['file-error:received'] || 0,
        sendUnavailable: peer.transferEvents?.['send-unavailable'] || 0,
        sendErrors: peer.transferEvents?.['send-error'] || 0,
        ignoredBeforeReady: peer.transferEvents?.['control-ignored-unready'] || 0,
        duplicateRequests: peer.transferEvents?.['duplicate-request-ignored'] || 0,
        sourceUnavailable: peer.transferEvents?.['source-unavailable'] || 0,
        senderFailures: peer.transferEvents?.['sender-failed'] || 0,
        cancelsSent: peer.transferEvents?.['cancel-file:sent'] || 0,
        cancelsReceived: peer.transferEvents?.['cancel-file:received'] || 0,
        cancelAcksSent: peer.transferEvents?.['file-canceled:sent'] || 0,
        cancelAcksReceived: peer.transferEvents?.['file-canceled:received'] || 0,
        pathRechecksRetried: peer.transferEvents?.['route-check-retried'] || 0,
        pathRechecksRecovered: peer.transferEvents?.['route-check-recovered'] || 0,
        pathRechecksFailed: peer.transferEvents?.['route-check-failed'] || 0,
        lastPathRecheckCode: peer.lastRouteCheckCode || null,
        lastPathRecheckEvidence: peer.lastRouteCheckEvidence || null,
        pathProofRequestsSent: peer.transferEvents?.['route-proof-request:sent'] || 0,
        pathProofRepliesReceived: peer.transferEvents?.['route-proof:received'] || 0,
        catalogsSent: peer.transferEvents?.['file-list:sent'] || 0,
        catalogsReceived: peer.transferEvents?.['file-list:received'] || 0,
        catalogsIgnoredBeforeReady: peer.transferEvents?.['catalog-ignored-unready'] || 0,
        catalogRefreshRequestsSent: peer.transferEvents?.['catalog-refresh-request:sent'] || 0,
        catalogRefreshRequestsReceived: peer.transferEvents?.['catalog-refresh-request:received'] || 0,
        catalogRequestsSent: peer.transferEvents?.['file-list-request:sent'] || 0,
        catalogRequestsReceived: peer.transferEvents?.['file-list-request:received'] || 0,
        ignoredStarts: peer.transferEvents?.['start-ignored-mismatch'] || 0,
        ignoredErrors: peer.transferEvents?.['error-ignored-mismatch'] || 0,
        endsReceived: peer.transferEvents?.['file-end:received'] || 0,
        endsIgnored: peer.transferEvents?.['end-ignored'] || 0,
        endsSizeMismatch: peer.transferEvents?.['end-size-mismatch'] || 0,
        endsChecksumMismatch: peer.transferEvents?.['end-checksum-mismatch'] || 0,
        endsVerified: peer.transferEvents?.['end-verified'] || 0,
        endsChecksumError: peer.transferEvents?.['end-checksum-error'] || 0,
        binaryIgnored: peer.transferEvents?.['binary-ignored'] || 0,
        lastEvent: peer.lastTransferEvent || 'none',
        activeReceiveStage: state.active?.peerId !== peer.id ? null
          : state.active.status === '等待发送端' ? 'awaiting-response'
          : state.active.status === '发送端已响应，等待文件启动' ? 'awaiting-file-start'
          : state.active.status === '传输中' ? 'receiving'
          : 'other',
      },
      // Do not copy room codes, member names, IP addresses or file names.
      reason: String(peer.reason ?? '').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]').slice(0, 180),
    })),
  };
}
// Diagnostic evidence only: a successful addIceCandidate() can still leave ICE
// without a usable or browser-reported candidate pair, especially with mDNS.
function diagnoseIce(peer, stats) {
  const remoteLines = (peer.pc.remoteDescription?.sdp || '').split(/\r?\n/)
    .filter(line => line.startsWith('a=candidate:'));
  const localLines = (peer.pc.localDescription?.sdp || '').split(/\r?\n/)
    .filter(line => line.startsWith('a=candidate:'));
  const mdns = lines => lines.filter(line => /\.local(?=\s|$)/i.test(line)).length;
  const pairs = stats.filter(item => item.type === 'candidate-pair');
  const remoteStats = stats.filter(item => item.type === 'remote-candidate');
  const counts = pairs.reduce((total, pair) => {
    for (const key of ['requestsSent', 'requestsReceived', 'responsesSent', 'responsesReceived']) {
      if (typeof pair[key] === 'number') total[key] += pair[key];
    }
    return total;
  }, { requestsSent: 0, requestsReceived: 0, responsesSent: 0, responsesReceived: 0 });
  const iceState = peer.pc.iceConnectionState;
  let code = 'insufficient-evidence';
  let interpretation = 'ICE 统计不足，需结合另一端的相同轮次诊断';
  if (iceState === 'connected' || iceState === 'completed') {
    code = 'ice-connected';
    interpretation = 'ICE 已建立连接，下一步检查路径验证与 DataChannel';
  } else if (pairs.some(pair => typeof pair.responsesReceived === 'number') &&
             counts.requestsSent > 0 && counts.responsesReceived === 0) {
    code = 'checks-without-response';
    interpretation = '浏览器报告已经发送 ICE 检查，但未报告收到响应；检查网络隔离、UDP 或对端状态';
  } else if (pairs.length === 0 && (peer.acceptedCandidates || 0) > 0 &&
             remoteStats.length === 0 && mdns(remoteLines) > 0) {
    code = 'mdns-resolution-or-candidate-pair-suspected';
    interpretation = '已接收 .local 主机候选，但浏览器未报告远端候选或候选连接对；优先排查 mDNS 解析及网络接口策略（不能据此断定解析失败）';
  } else if (pairs.length === 0 && (peer.remoteCandidateCount || 0) > 0) {
    code = 'no-candidate-pair-reported';
    interpretation = '已收到 ICE 候选，但浏览器未报告连接对；不代表绝对没有执行 ICE 检查';
  } else if (pairs.length > 0) {
    code = 'candidate-pair-reported';
    interpretation = '浏览器报告了候选连接对；根据状态和检查计数继续判断';
  }
  return {
    code, interpretation, iceState,
    localCandidateLines: localLines.length,
    remoteCandidateLines: remoteLines.length,
    localMdnsLines: mdns(localLines),
    remoteMdnsLines: mdns(remoteLines),
    candidatesAcceptedByApi: peer.acceptedCandidates || 0,
    candidatesRejectedByApi: peer.rejectedCandidates || 0,
    remoteCandidateStatsReported: remoteStats.length,
    candidatePairsReported: pairs.length,
    reportedCheckCounters: counts,
    caveat: '浏览器可能隐藏 ICE 地址或省略统计；addIceCandidate 成功不保证地址已解析或网络可达。',
  };
}
// Full evidence is intentionally opt-in. Normal copy diagnostics remain redacted.
async function buildDiagnosticsReport() {
  const summary = diagnosticsSnapshot();
  if (mirroredRoom) return summary;
  if (!FULL_DEBUG) {
    // Include ICE evidence without exposing raw SDP, IP addresses or room credentials.
    const peers = await Promise.all([...state.peers.values()].map(async (peer, index) => {
      let iceDiagnosis;
      try {
        iceDiagnosis = diagnoseIce(peer, [...(await peer.pc.getStats()).values()]);
      } catch {
        iceDiagnosis = {
          code: 'stats-unavailable',
          interpretation: '浏览器未返回 ICE 连接统计，需检查另一端设备',
        };
      }
      return { ...summary.peers[index], iceDiagnosis };
    }));
    return { ...summary, peers };
  }
  const detailedPeers = await Promise.all([...state.peers.values()].map(async (peer, index) => {
    let stats = [];
    let statsError = null;
    try {
      const report = await peer.pc.getStats();
      stats = [...report.values()].map(item => ({ ...item }));
    } catch (error) {
      statsError = String(error);
    }
    const candidates = type => stats.filter(item => item.type === type);
    const pairs = candidates('candidate-pair').map(pair => ({
      id: pair.id, state: pair.state, nominated: pair.nominated, selected: pair.selected,
      localCandidateId: pair.localCandidateId, remoteCandidateId: pair.remoteCandidateId,
      requestsSent: pair.requestsSent, requestsReceived: pair.requestsReceived,
      responsesSent: pair.responsesSent, responsesReceived: pair.responsesReceived,
      bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived,
    }));
    return {
      device: index + 1, id: peer.id, name: peer.name, generation: peer.generation,
      initiator: peer.initiator, attempt: peer.attempt, stage: peer.stage,
      handshake: {
        localPathVerified: peer.verified, localReadySent: peer.localReadySent,
        remoteReadyReceived: peer.remoteReady,
        remoteHostPairVerified: peer.remoteHostPairVerified, transferReady: peer.ready,
      },
      localDescription: peer.pc.localDescription?.toJSON?.() ?? peer.pc.localDescription ?? null,
      remoteDescription: peer.pc.remoteDescription?.toJSON?.() ?? peer.pc.remoteDescription ?? null,
      receivedCandidates: peer.remoteCandidateCount || 0,
      acceptedCandidates: peer.acceptedCandidates || 0,
      rejectedCandidates: peer.rejectedCandidates || 0,
      queuedRemoteCandidates: peer.candidates,
      pendingLocalCandidates: peer.localCandidates,
      iceSummary: {
        localCandidates: candidates('local-candidate'),
        remoteCandidates: candidates('remote-candidate'),
        candidatePairs: pairs,
        transports: candidates('transport'),
      },
      statsError,
      iceDiagnosis: diagnoseIce(peer, stats),
      stats,
    };
  }));
  return {
    ...summary,
    fullDebug: true,
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    room: { code: state.code, id: state.id, name: deviceName(), token: state.token, generation: state.generation },
    detailedPeers,
    events: debugEvents.slice(),
  };
}
function renderDiagnostics() {
  scheduleRoomView();
  const panel = $('diagnostics-panel');
  if (panel.hidden) return;
  const data = diagnosticsSnapshot();
  const root = $('diagnostics-content');
  root.replaceChildren();
  if (mirrorActionsUnavailable()) {
    root.append(elem('p', 'diagnostic-line', '原标签页已停止同步；以下为最后一次收到的诊断数据'));
  }
  const header = elem('p', 'diagnostic-line', data.peerCount ? `设备：${data.peerCount} · 可传：${data.peers.filter(peer => peer.canTransfer).length}` : '尚无其他设备');
  root.append(header);
  root.append(elem('p', 'diagnostic-line',
    `信令：${data.signal} · 房间进入：${data.roomEntry || '未进入'} · 心跳响应 ${data.signalKeepalive.acksReceived}/${data.signalKeepalive.sent} · 超时 ${data.signalKeepalive.timeouts} · 断开 ${data.signalKeepalive.disconnects} · 自动重连 ${data.signalKeepalive.reconnectsScheduled}`));
  if (data.signalErrors) {
    root.append(elem('p', 'diagnostic-line',
      `信令错误：${data.signalErrors} · ${data.lastSignalError}`));
  }
  for (const peer of data.peers) {
    const line = elem('p', 'diagnostic-line');
    line.append(elem('strong', '', `设备 ${peer.device}  `));
    line.append(document.createTextNode(`${peer.connection} / ${peer.ice} / ${peer.channel} · ${peer.stage} · ${peer.reason || '等待连接'}`));
    root.append(line);
    if (peer.route) {
      root.append(elem('p', 'diagnostic-line', `路径：${peer.route.code}（本地 ${peer.route.localAddressKind} / 远端 ${peer.route.remoteAddressKind}）`));
    }
    root.append(elem('p', 'diagnostic-line',
      `第 ${peer.attempt} 次协商 · 累计 ${peer.setupElapsedSeconds} 秒 · ${peer.timeToReadySeconds === null ? '尚未就绪' : `首次就绪耗时 ${peer.timeToReadySeconds} 秒`}`));
    root.append(elem('p', 'diagnostic-line',
      `协商记录：${peer.iceAttempts.map(a => `#${a.attempt} ${a.role} ${a.ice}/${a.outcome}`).join(' → ')}`));
    root.append(elem('p', 'diagnostic-line',
      `文件请求 发/收 ${peer.transfer.requestsSent}/${peer.transfer.requestsReceived} · 确认 发/收 ${peer.transfer.acksSent}/${peer.transfer.acksReceived} · 启动 发/收 ${peer.transfer.startsSent}/${peer.transfer.startsReceived} · 最近 ${peer.transfer.lastEvent}`));
  }
}
$('toggle-diagnostics').addEventListener('click', () => {
  const panel = $('diagnostics-panel');
  panel.hidden = !panel.hidden;
  $('toggle-diagnostics').setAttribute('aria-expanded', String(!panel.hidden));
  renderDiagnostics();
});
$('copy-diagnostics').addEventListener('click', async () => {
  const report = JSON.stringify(await buildDiagnosticsReport(), null, 2);
  try { await navigator.clipboard.writeText(report); showToast('诊断已复制'); }
  catch {
    // Mobile Firefox may reject clipboard access. Both report modes can be
    // downloaded locally without sending diagnostics through signaling.
    try {
      const url = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = FULL_DEBUG ? 'lan-room-ice-debug.json' : 'lan-room-ice-diagnostics.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      feedback(FULL_DEBUG ? '复制受限，已尝试下载完整诊断 JSON' : '复制受限，已尝试下载脱敏诊断 JSON');
    } catch { feedback('无法复制或下载，请截图诊断区域', true); }
  }
});
function renderSentFiles() {
  scheduleRoomView();
  const container = $('sent-files');
  container.replaceChildren();
  const shared = state.ownOffers.flatMap(offer => offer.files.map(file => ({ ...file, offerId: offer.offerId })));
  container.hidden = shared.length === 0;
  for (const file of shared.slice().reverse()) {
    const line = elem('div', 'file-row');
    line.append(elem('span', 'file-icon', '↑'));
    const info = elem('div', 'item-info');
    const count = [...state.peers.values()].filter(peer => peer.ready).length;
    info.append(elem('strong', '', file.name), elem('span', '', `${humanSize(file.size)} · ${count ? `可供 ${count} 台设备接收` : '等待设备直连'}`));
    line.append(info);
    const button = addButton(line, '移除',
      () => withdrawSharedFile(file.offerId, file.id), 'quiet-button small-button');
    button.disabled = mirrorActionsUnavailable();
    container.append(line);
  }
}
function renderRoomFiles() {
  scheduleRoomView();
  const root = $('incoming-requests');
  root.replaceChildren();
  const offers = [...state.offers.values()];
  const jobsByFile = new Map(state.jobs.map(job =>
    [`${job.peerId}:${job.offerId}:${job.fileId}`, job]));
  const shownJobs = new Set();
  let count = 0;

  function appendFileRow(container, file, offer, job) {
    const row = elem('div', job ? 'file-row job-row' : 'file-row');
    row.append(elem('div', 'file-icon', job ? '↓' : '↧'));
    const info = elem('div', 'item-info');
    info.append(elem('strong', '', file.name));
    if (job) {
      info.append(elem('span', '', `${job.status} · ${humanSize(job.received)} / ${humanSize(job.size)}`));
      const progress = elem('div', 'progress');
      const bar = elem('div');
      bar.style.width = `${job.size ? Math.min(100, job.received / job.size * 100) : (job.url ? 100 : 0)}%`;
      progress.append(bar);
      info.append(progress);
      if (job.url && job.size === 0) {
        info.append(elem('span', '', '空文件（0 B）可能无法在部分设备保存；校验通过不代表已保存到本地'));
      }
    } else {
      info.append(elem('span', '', humanSize(file.size)));
    }
    row.append(info);
    const actions = elem('div', 'job-actions');
    if (!job && file.status === 'pending') {
      const button = addButton(actions, '接收', () => acceptFile(offer, file));
      button.disabled = mirrorActionsUnavailable() || !state.peers.get(offer.peerId)?.ready;
    } else if (job?.url) {
      const link = elem('a', 'download-link', '保存');
      link.href = job.url;
      link.download = job.name;
      actions.append(link);
    } else if (job && (job.recovering || state.active === job || state.queue.includes(job))) {
      if (!job.cancelled) {
        const button = addButton(actions, '取消', () => cancelJob(job), 'secondary small-button');
        button.disabled = mirrorActionsUnavailable();
      }
    } else if (job && (job.status.startsWith('失败') || job.status === '已取消')) {
      const button = addButton(actions, '重试', () => retryJob(job), 'secondary small-button');
      button.disabled = mirrorActionsUnavailable();
    } else if (!job) {
      actions.append(elem('span', file.status === 'complete' ? 'chip ready' : 'chip',
        ({ queued: '已加入队列', complete: '已接收', failed: '接收失败' })[file.status] || file.status));
    }
    row.append(actions);
    container.append(row);
  }

  // Several batches from one real device are separate offers in the
  // protocol, but belong under ONE device heading in the room UI.
  const offersByPeer = new Map();
  for (const offer of offers) {
    if (!offersByPeer.has(offer.peerId)) offersByPeer.set(offer.peerId, []);
    offersByPeer.get(offer.peerId).push(offer);
  }
  for (const [peerId, peerOffers] of offersByPeer) {
    const peer = state.peers.get(peerId);
    const entries = peerOffers.flatMap(offer =>
      offer.files.map(file => ({ offer, file })));
    const group = elem('div', 'request');
    const top = elem('div', 'request-head');
    top.append(elem('strong', '', peer ? peerDisplayName(peer) : '已离线设备'),
      elem('small', '', `${entries.length} 个文件`));
    group.append(top);
    for (const { offer, file } of entries) {
      const job = jobsByFile.get(`${offer.peerId}:${offer.offerId}:${file.id}`);
      if (job) shownJobs.add(job);
      appendFileRow(group, file, offer, job);
      count += 1;
    }
    const pending = entries.filter(({ file }) => file.status === 'pending');
    if (pending.length) {
      const foot = elem('div', 'request-footer');
      const button = addButton(foot, `接收全部 (${pending.length})`,
        () => pending.forEach(({ offer, file }) => acceptFile(offer, file)),
        'primary small-button');
      button.disabled = mirrorActionsUnavailable() || !peer?.ready;
      group.append(foot);
    }
    root.append(group);
  }

  // Keep locally saved files and terminated jobs available after a sender
  // withdraws a file or leaves the room; never render the same job twice.
  const olderJobs = state.jobs.filter(job => !shownJobs.has(job));
  if (olderJobs.length) {
    const group = elem('div', 'request');
    const top = elem('div', 'request-head');
    top.append(elem('strong', '', '已撤回或离线的文件'),
      elem('small', '', `${olderJobs.length} 个文件`));
    group.append(top);
    for (const job of [...olderJobs].reverse()) appendFileRow(group, job, null, job);
    root.append(group);
    count += olderJobs.length;
  }

  $('request-count').textContent = `${count} 个文件`;
  if (!count) root.append(elem('p', 'empty', '暂无文件'));
  qaRender();
}

$('qa-panel').hidden = !QA_MODE;
$('qa-enable').hidden = QA_MODE;
$('qa-enable').onclick = () => {
  // The room toolbar makes QA discoverable without manually editing the URL.
  // Opt-in is local to this page and never starts a transfer by itself.
  QA_MODE = true;
  $('qa-panel').hidden = false;
  $('qa-enable').hidden = true;
  $('qa-enable').setAttribute('aria-expanded', 'true');
  qaRender();
  renderDiagnostics();
  feedback('并发验收已开启：请在上方先选择文件并点击“准备接收”');
  $('qa-panel').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
};
$('qa-arm').onclick = qaArmSelected;
$('qa-start').onclick = qaStartAll;
$('qa-cancel').onclick = qaCancelPlan;
if (QA_MODE) qaRender();

updateDeviceAvatar();
for (const [buttonId, labelId, avatarId] of [
  ['edit-home-device-name', 'home-device-label', 'home-device-avatar'],
  ['edit-device-name', 'my-device-label', 'my-device-avatar'],
]) {
  const label = $(labelId);
  $(buttonId).onclick = () => beginDeviceNameEdit(labelId);
  label.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finishDeviceNameEdit(labelId);
      label.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishDeviceNameEdit(labelId, true);
      label.blur();
    }
  });
  label.addEventListener('beforeinput', event => {
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') event.preventDefault();
  });
  label.addEventListener('input', () => {
    $(avatarId).textContent = deviceAvatar(label.textContent.trim() || deviceName());
  });
  label.addEventListener('blur', () => finishDeviceNameEdit(labelId));
}
const codeInput = $('room-code-input');
async function suggestCode() {
  const current = codeInput.value;
  try {
    const response = await fetch('/api/suggest-code', { cache: 'no-store' });
    if (!response.ok) throw new Error('暂时无法获取新房间码');
    const { code } = await response.json();
    if (codeInput.value === current) codeInput.value = normalizeRoomCode(code);
  } catch { /* Keep the locally generated four-digit fallback. */ }
}
const priorSession = remembered();
let priorMirrorCode = null;
try { priorMirrorCode = sessionStorage.getItem('lan-room-mirror-code'); }
catch { /* Storage may be blocked. */ }
if (priorSession?.code && /^[A-Z0-9]{4,16}$/.test(priorSession.code)) {
  codeInput.value = priorSession.code;
} else if (priorMirrorCode && /^[A-Z0-9]{4,16}$/.test(priorMirrorCode)) {
  codeInput.value = priorMirrorCode;
} else {
  codeInput.value = generateRandomRoomCode();
  suggestCode();
}
$('regenerate-code').onclick = () => {
  codeInput.value = generateRandomRoomCode();
  suggestCode();
};
codeInput.oninput = event => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
};
$('enter-room').onclick = async () => {
  if ($('enter-room').disabled) return;
  try {
    const code = normalizeRoomCode(codeInput.value);
    currentRoomExitRevision = readRoomExitRevision(code);
    setEntryLoading(true);
    const acquired = await acquireRoomTab(code);
    if (readRoomExitRevision(code) !== currentRoomExitRevision) {
      if (acquired) releaseRoomTab(false);
      currentRoomExitRevision = null;
      setEntryLoading(false);
      feedback('房间已退出，请重新进入');
      return;
    }
    if (!acquired) {
      await openMirroredRoom(code);
      return;
    }
    startOwnerRoomChannel(code);
    const action = { type: 'enter', code, name: deviceName() };
    const session = remembered();
    if (session?.code === code) { action.id = session.id; action.token = session.token; }
    connect(action);
  } catch (e) {
    releaseRoomTab();
    setEntryLoading(false);
    feedback(e.message, true);
  }
};
function leaveRoomLocally() {
  if (mirroredRoom) {
    closeMirroredRoom();
    currentRoomExitRevision = null;
    feedback('已退出房间');
    return;
  }
  if (!state.code && !ownerRoomChannel) return;
  state.leaving = true;
  stopReconnect();
  stopSignalKeepalive();
  signalRecover = null;
  qaCancelPlan();
  reconnectAttempts = 0;
  sessionStorage.removeItem('lan-room-session');
  for (const job of state.jobs) if (job.url) URL.revokeObjectURL(job.url);
  state.jobs = []; state.queue = []; state.active = null; state.offers.clear(); state.outbound.clear();
  state.ownOffers = [];
  state.ws?.close(); state.ws = null;
  // No automatic takeover on an explicit Leave; every mirror is exiting.
  releaseRoomTab(false);
  for (const peer of state.peers.values()) { clearTimeout(peer.connectTimer); peer.pc.close(); }
  state.peers.clear();
  state.code = ''; state.id = ''; state.token = '';
  state.generation = ''; state.lastRoomEntry = null;
  currentRoomExitRevision = null;
  setEntryLoading(false);
  showRoom(false); renderPeers(); renderSentFiles(); feedback('已退出房间');
}
function leaveRoomEverywhere() {
  const code = mirroredRoom?.code || state.code;
  if (!code) return;
  if (state.active && !confirm('当前有文件正在传输，退出将中断此任务。确定退出？')) return;
  // Persistent room-scoped revision closes tabs delayed by background
  // throttling and prevents their queued Web Lock from reviving this room.
  try { window.localStorage.setItem(roomExitKey(code), crypto.randomUUID()); }
  catch { /* BroadcastChannel still reaches active tabs. */ }
  (mirroredRoom?.channel || ownerRoomChannel?.channel)?.postMessage({
    type: 'leave-all', code,
  });
  leaveRoomLocally();
}
$('leave-room').onclick = leaveRoomEverywhere;
window.addEventListener('storage', event => {
  const code = mirroredRoom?.code || state.code;
  if (code && event.key === roomExitKey(code) &&
      event.newValue !== null && event.newValue !== currentRoomExitRevision) {
    leaveRoomLocally();
  }
});
$('copy-code').onclick = async () => {
  try { await navigator.clipboard.writeText(state.code); showToast('房间号已复制'); }
  catch { feedback(`房间码：${state.code}`); }
};
$('drop-zone').addEventListener('click', () => {
  const picker = $('send-files');
  picker.value = '';
  picker.click();
});
const dropZone = $('drop-zone');
dropZone.addEventListener('dragover', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dropZone.classList.add('is-dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragover'));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('is-dragover');
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) shareFiles(files);
});
$('send-files').addEventListener('change', event => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) shareFiles(files);
});
window.addEventListener('beforeunload', event => {
  if (state.active) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => {
  // A tab/window close does not remove the logical device's shared files.
  // The controller republishes its existing File handles to surviving tabs
  // before its Web Lock is released; a mirror simply closes.
  if (!mirroredRoom && ownerRoomChannel) {
    broadcastRoomHandoff();
    broadcastRoomView();
  }
});
