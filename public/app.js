import { inspectSelectedPath } from './route-policy.js';
import { DEVICE_NAME_KEY, deviceAvatar, generateDeviceName, getOrCreateDeviceName } from './device-name.js';
import { generateRandomRoomCode, normalizeRoomCode } from './room-code.js';

// Research prototype only. Browser APIs cannot reliably prove the OS routing path.
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;
const MAX_FILES = 20;
const $ = id => document.getElementById(id);
const state = {
  ws: null, code: '', id: '', token: '', leaving: false, peers: new Map(),
  outbound: new Map(), ownOffers: [], offers: new Map(), jobs: [], queue: [], active: null,
};

let currentDeviceName;
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
  ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
function feedback(text, error = false) {
  $('feedback').textContent = text;
  $('feedback').className = error ? 'feedback error' : 'feedback';
}
function showRoom(visible) {
  $('room-screen').hidden = !visible;
  $('home-screen').hidden = visible;
  updateConnectionSummary();
}
function updateConnectionSummary() {
  const status = $('connection-status');
  if ($('room-screen').hidden) {
    status.textContent = '未连接';
    status.dataset.state = 'offline';
    return;
  }
  const peers = [...state.peers.values()];
  const ready = peers.filter(peer => peer.ready).length;
  status.textContent = ready ? '文件直连就绪' : peers.length ? '直连未就绪' : '房间已连接';
  status.dataset.state = ready ? 'ready' : 'waiting';
}
function sendSignal(to, signal) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'signal', to, signal }));
  }
}
function sendPeer(peer, control) {
  if (!peer?.ready || peer.channel?.readyState !== 'open') return false;
  peer.channel.send(JSON.stringify(control));
  return true;
}
function deviceName() { return currentDeviceName; }
function updateDeviceAvatar() {
  const homeName = $('device-name').value.trim() || deviceName();
  $('home-device-avatar').textContent = deviceAvatar(homeName);
  $('home-device-label').textContent = homeName;
  $('my-device-avatar').textContent = deviceAvatar(deviceName());
}
function saveDeviceName(inputId) {
  const name = $(inputId).value.trim();
  if (!name || name.length > 40) {
    feedback('\u8bbe\u5907\u540d\u79f0\u9700\u8981\u4e3a 1\u201340 \u4e2a\u5b57\u7b26', true);
    return null;
  }
  currentDeviceName = name;
  $('device-name').value = name;
  $('room-device-name').value = name;
  $('my-device-label').textContent = name;
  updateDeviceAvatar();
  try { window.localStorage.setItem(DEVICE_NAME_KEY, name); }
  catch { /* Private mode may deny storage. */ }
  if (state.code && state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'rename', name }));
  }
  return name;
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
function connect(action) {
  if (state.ws && state.ws.readyState < WebSocket.CLOSING) return;
  feedback('正在连接协调服务…');
  state.leaving = false;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener('open', () => ws.send(JSON.stringify(action)));
  ws.addEventListener('message', async event => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { return; }
    try { await handleServer(msg); }
    catch (err) { feedback(`连接处理失败：${err.message}`, true); }
  });
  ws.addEventListener('close', () => {
    if (state.ws !== ws) return;
    state.ws = null;
    for (const peer of state.peers.values()) peer.pc.close();
    state.peers.clear();
    failActive('信令连接断开');
    showRoom(false);
    renderPeers();
    if (!state.leaving) feedback('协调服务已断开，可尝试恢复房间会话', true);
    state.code = ''; state.ownOffers = []; state.outbound.clear(); state.offers.clear();
    renderSentFiles(); renderRequests();
  });
  ws.addEventListener('error', () => feedback('无法连接协调服务，请检查地址与网络', true));
}
async function handleServer(msg) {
  switch (msg.type) {
    case 'error':
      feedback(msg.message || '未知错误', true);
      // A failed room entry must not leave the page stuck on an open WS.
      if (!state.code && state.ws) { state.leaving = true; state.ws.close(); }
      break;
    case 'welcome':
      state.code = msg.code; state.id = msg.id; state.token = msg.token;
      rememberRoom(); showRoom(true); $('room-name').textContent = msg.code;
      $('room-code-input').value = msg.code;
      // Resume may restore a server-side name from before the last local edit.
      if (msg.name !== currentDeviceName) {
        state.ws?.send(JSON.stringify({ type: 'rename', name: currentDeviceName }));
      }
      feedback('已进入房间，等待设备建立局域网连接');
      for (const other of msg.peers) await createPeer(other.id, other.name, true);
      renderPeers(); renderRequests(); renderJobs(); renderSentFiles(); break;
    case 'peer-online':
      if (msg.id !== state.id) await createPeer(msg.id, msg.name, false);
      renderPeers(); break;
    case 'peer-offline': {
      const peer = state.peers.get(msg.id);
      if (peer) { peer.pc.close(); state.peers.delete(msg.id); }
      if (state.active?.peerId === msg.id) failActive('发送设备已离线');
      discardPeerOffers(msg.id);
      renderPeers(); renderRequests(); renderJobs(); break;
    }
    case 'peer-name': {
      const peer = state.peers.get(msg.id);
      if (peer) { peer.name = msg.name; renderPeers(); renderRequests(); }
      break;
    }
    case 'signal':
      await handleSignal(msg.from, msg.signal); break;
    default: break;
  }
}

async function createPeer(id, name, initiator) {
  if (state.peers.has(id)) return state.peers.get(id);
  const pc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all' });
  const peer = { id, name, pc, channel: null, verified: false, remoteReady: false,
    ready: false, reason: '正在建立连接', candidates: [], sending: new Map(), syncedOffers: new Set() };
  state.peers.set(id, peer);
  pc.onicecandidate = event => {
    if (!event.candidate) return;
    const candidate = event.candidate.toJSON();
    // Host candidates only: no STUN, no TURN and no server-relayed file bytes.
    if (/\btyp host\b/.test(candidate.candidate)) sendSignal(id, { type: 'candidate', candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      peer.ready = false;
      peer.reason = `连接状态：${pc.connectionState}`;
      if (state.active?.peerId === id) failActive('设备连接中断');
    } else if (pc.connectionState === 'connected' && !peer.ready) {
      peer.reason = '正在验证局域网路径';
    }
    renderPeers();
  };
  pc.oniceconnectionstatechange = () => renderDiagnostics();
  pc.ondatachannel = event => attachChannel(peer, event.channel);
  if (initiator) {
    attachChannel(peer, pc.createDataChannel('room-files', { ordered: true }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(id, { type: 'offer', sdp: pc.localDescription.sdp });
  }
  return peer;
}

async function handleSignal(id, signal) {
  if (!signal || !['offer', 'answer', 'candidate'].includes(signal.type)) return;
  const peer = state.peers.get(id) || await createPeer(id, '其他设备', false);
  if (signal.type === 'offer') {
    await peer.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    await flushCandidates(peer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    sendSignal(id, { type: 'answer', sdp: peer.pc.localDescription.sdp });
  } else if (signal.type === 'answer') {
    await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    await flushCandidates(peer);
  } else if (signal.candidate?.candidate?.includes(' typ host ')) {
    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate);
    else peer.candidates.push(signal.candidate);
  }
}
async function flushCandidates(peer) {
  for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
}

function attachChannel(peer, channel) {
  peer.channel = channel;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 128 * 1024;
  channel.onmessage = event => receiveChannel(peer, event.data);
  channel.onclose = () => { peer.ready = false; peer.reason = '文件通道已断开'; renderPeers(); };
  channel.onerror = () => { peer.ready = false; peer.reason = '文件通道错误'; renderPeers(); };
  channel.onopen = async () => {
    for (let count = 0; count < 20 && channel.readyState === 'open'; count += 1) {
      let verdict;
      try { verdict = await inspectSelectedPath(peer.pc); }
      catch (err) { verdict = { allowed: false, reason: `路径检查失败：${err.message}` }; }
      peer.reason = verdict.reason;
      if (verdict.allowed) {
        peer.verified = true;
        channel.send(JSON.stringify({ kind: 'ready' }));
        peer.ready = peer.remoteReady;
        syncSharedOffers(peer);
        renderPeers();
        return;
      }
      renderPeers();
      await new Promise(resolve => setTimeout(resolve, 600));
    }
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
  if (msg.kind === 'ready') {
    peer.remoteReady = true;
    peer.ready = peer.verified;
    syncSharedOffers(peer);
    renderPeers();
    return;
  }
  if (!peer.ready) return;
  if (msg.kind === 'file-list') {
    if (typeof msg.offerId !== 'string' || !Array.isArray(msg.files) || msg.files.length > MAX_FILES ||
        msg.files.some(f => typeof f.id !== 'string' || typeof f.name !== 'string' ||
          f.name.length > 255 || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES)) return;
    const key = `${peer.id}:${msg.offerId}`;
    if (state.offers.has(key)) return;
    state.offers.set(key, { peerId: peer.id, offerId: msg.offerId,
      files: msg.files.map(f => ({ id: f.id, name: f.name, size: f.size, status: 'pending' })) });
    renderRequests();
    feedback(`${peer.name} 分享了 ${msg.files.length} 个文件`);
  } else if (msg.kind === 'file-withdraw') {
    if (typeof msg.offerId === 'string' && typeof msg.fileId === 'string') {
      withdrawPeerFile(peer.id, msg.offerId, msg.fileId);
    }
  } else if (msg.kind === 'request-file') {
    void startSendingFile(peer, msg);
  } else if (msg.kind === 'cancel-file') {
    peer.sending.get(msg.fileId)?.cancel();
  } else if (msg.kind === 'file-start') {
    const job = state.active;
    if (!job || job.peerId !== peer.id || job.fileId !== msg.fileId || job.offerId !== msg.offerId || msg.size !== job.size) return;
    job.status = '传输中'; job.received = 0; job.chunks = []; renderJobs();
  } else if (msg.kind === 'file-end') {
    const job = state.active;
    if (!job || job.peerId !== peer.id || job.fileId !== msg.fileId) return;
    if (job.cancelled) { finishJob('已取消'); return; }
    if (job.received !== job.size) { failActive('文件大小不匹配'); return; }
    const url = URL.createObjectURL(new Blob(job.chunks));
    job.url = url; job.chunks = [];
    finishJob('已传输，点击保存');
  } else if (msg.kind === 'file-canceled') {
    if (state.active?.peerId === peer.id && state.active?.fileId === msg.fileId) finishJob('已取消');
  } else if (msg.kind === 'file-error') {
    if (state.active?.peerId === peer.id && state.active?.fileId === msg.fileId) failActive(msg.message || '发送方读取失败');
  }
}
function handleBinary(peer, data) {
  const job = state.active;
  if (!peer.ready || !job || job.peerId !== peer.id || job.status !== '传输中' || !(data instanceof ArrayBuffer)) return;
  if (data.byteLength > CHUNK_SIZE || job.received + data.byteLength > job.size) { failActive('数据块超过允许大小'); return; }
  if (!job.cancelled) job.chunks.push(data);
  job.received += data.byteLength;
  renderJobs();
}

async function startSendingFile(peer, request) {
  const offer = state.outbound.get(request.offerId);
  const file = offer?.get(request.fileId);
  if (!file || !peer.ready) {
    sendPeer(peer, { kind: 'file-error', fileId: request.fileId, message: '原文件已不可用，请重新选择发送' });
    return;
  }
  if (peer.sending.has(request.fileId)) return;
  const token = { cancelled: false, cancel() { this.cancelled = true; } };
  peer.sending.set(request.fileId, token);
  try {
    const path = await inspectSelectedPath(peer.pc);
    if (!path.allowed) throw new Error(path.reason);
    if (!sendPeer(peer, { kind: 'file-start', offerId: request.offerId, fileId: request.fileId, size: file.size })) throw new Error('设备连接断开');
    for (let offset = 0, block = 0; offset < file.size; offset += CHUNK_SIZE, block += 1) {
      if (token.cancelled) break;
      if (block % 16 === 0) {
        const fresh = await inspectSelectedPath(peer.pc);
        if (!fresh.allowed) throw new Error('传输途中路径检查失败，已停止');
      }
      const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      while (peer.channel.bufferedAmount > 512 * 1024 && !token.cancelled) {
        if (peer.channel.readyState !== 'open') throw new Error('连接断开');
        await new Promise(resolve => setTimeout(resolve, 45));
      }
      if (!token.cancelled) peer.channel.send(chunk);
    }
    sendPeer(peer, { kind: token.cancelled ? 'file-canceled' : 'file-end', fileId: request.fileId });
  } catch (err) {
    sendPeer(peer, { kind: 'file-error', fileId: request.fileId, message: String(err.message).slice(0, 160) });
  } finally {
    peer.sending.delete(request.fileId);
  }
}

function acceptFile(offer, file) {
  if (file.status !== 'pending') return;
  file.status = 'queued';
  const job = { peerId: offer.peerId, offerId: offer.offerId, fileId: file.id,
    name: file.name, size: file.size, received: 0, chunks: [], status: '排队中', url: null, cancelled: false };
  state.jobs.push(job);
  state.queue.push(job);
  renderRequests(); renderJobs(); startNext();
}
function startNext() {
  if (state.active || state.queue.length === 0) return;
  const job = state.queue.shift();
  const peer = state.peers.get(job.peerId);
  if (!peer?.ready) {
    job.status = '失败：设备暂不可用'; renderJobs(); startNext(); return;
  }
  state.active = job;
  job.status = '等待发送端';
  job.timer = setTimeout(() => { if (state.active === job) failActive('等待发送端超时'); }, 20000);
  sendPeer(peer, { kind: 'request-file', offerId: job.offerId, fileId: job.fileId });
  renderJobs();
}
function finishJob(status) {
  const job = state.active;
  if (!job) return;
  if (job.timer) clearTimeout(job.timer);
  job.status = status;
  const offer = state.offers.get(`${job.peerId}:${job.offerId}`);
  const file = offer?.files.find(f => f.id === job.fileId);
  if (file) file.status = status === '已传输，点击保存' ? 'complete' : 'failed';
  job.chunks = [];
  state.active = null;
  renderRequests(); renderJobs();
  queueMicrotask(startNext);
}
function failActive(reason) { if (state.active) finishJob(`失败：${reason}`); }
function cancelJob(job) {
  if (state.active === job) {
    job.cancelled = true;
    job.chunks = [];
    state.peers.get(job.peerId) && sendPeer(state.peers.get(job.peerId), { kind: 'cancel-file', fileId: job.fileId });
    job.status = '正在取消';
    renderJobs();
  } else if (state.queue.includes(job)) {
    state.queue.splice(state.queue.indexOf(job), 1);
    job.status = '已取消';
    const offer = state.offers.get(`${job.peerId}:${job.offerId}`);
    const file = offer?.files.find(f => f.id === job.fileId);
    if (file) file.status = 'failed';
    renderJobs(); renderRequests();
  }
}
function retryJob(job) {
  if (!job.status.startsWith('失败') && job.status !== '已取消') return;
  job.received = 0; job.chunks = []; job.cancelled = false; job.status = '排队中';
  const offer = state.offers.get(`${job.peerId}:${job.offerId}`);
  const file = offer?.files.find(f => f.id === job.fileId);
  if (file) file.status = 'queued';
  state.queue.push(job); renderJobs(); renderRequests(); startNext();
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
function shareFiles(files) {
  if (!state.code) { feedback('请先进入房间', true); return; }
  if (!files.length || files.length > MAX_FILES) { feedback('一次请选择 1–20 个文件', true); return; }
  if (files.some(file => file.size > MAX_FILE_BYTES)) { feedback('技术原型每个文件最大 32 MB', true); return; }
  const offerId = crypto.randomUUID();
  const fileMap = new Map();
  const metadata = files.map(file => {
    const id = crypto.randomUUID(); fileMap.set(id, file);
    return { id, name: file.name, size: file.size };
  });
  state.outbound.set(offerId, fileMap);
  state.ownOffers.push({ offerId, files: metadata });
  for (const peer of state.peers.values()) syncSharedOffers(peer);
  renderSentFiles();
  const ready = [...state.peers.values()].filter(peer => peer.ready).length;
  feedback(ready ? '文件已加入房间共享列表' : '文件已添加，等待设备直连');
}
function withdrawSharedFile(offerId, fileId) {
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
  renderSentFiles();
}
function withdrawPeerFile(peerId, offerId, fileId) {
  const key = `${peerId}:${offerId}`;
  const offer = state.offers.get(key);
  if (!offer) return;
  offer.files = offer.files.filter(file => file.id !== fileId);
  if (!offer.files.length) state.offers.delete(key);
  if (state.active?.peerId === peerId && state.active?.fileId === fileId) finishJob('已撤回');
  for (const job of state.queue.filter(job => job.peerId === peerId && job.fileId === fileId)) {
    job.status = '已撤回';
  }
  state.queue = state.queue.filter(job => !(job.peerId === peerId && job.fileId === fileId));
  renderRequests(); renderJobs();
}
function discardPeerOffers(peerId) {
  for (const [key, offer] of state.offers) {
    if (offer.peerId === peerId) state.offers.delete(key);
  }
  for (const job of state.queue.filter(job => job.peerId === peerId)) job.status = '发送设备已离线';
  state.queue = state.queue.filter(job => job.peerId !== peerId);
}
function renderPeers() {
  const list = $('peer-list');
  list.replaceChildren();
  const peers = [...state.peers.values()];
  $('device-count').textContent = `${peers.length} 台 · ${peers.filter(p => p.ready).length} 可传`;
  if (!peers.length) list.append(elem('p', 'empty', '暂无其他设备'));
  for (const peer of peers) {
    const row = elem('div', 'device-row');
    row.append(elem('div', 'device-icon', deviceAvatar(peer.name)));
    const info = elem('div', 'item-info');
    info.append(elem('strong', '', peer.name), elem('span', '', peer.ready ? '已连接' : peer.reason));
    row.append(info);
    list.append(row);
  }
  updateConnectionSummary();
  renderDiagnostics();
  renderSentFiles();
}
function diagnosticsSnapshot() {
  return {
    signal: state.ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
    peerCount: state.peers.size,
    peers: [...state.peers.values()].map((peer, index) => ({
      device: index + 1,
      connection: peer.pc?.connectionState ?? 'unknown',
      ice: peer.pc?.iceConnectionState ?? 'unknown',
      channel: peer.channel?.readyState ?? 'none',
      routeVerified: Boolean(peer.verified),
      peerVerified: Boolean(peer.remoteReady),
      canTransfer: Boolean(peer.ready),
      // Do not copy room codes, member names, IP addresses or file names.
      reason: String(peer.reason ?? '').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]').slice(0, 180),
    })),
  };
}
function renderDiagnostics() {
  const panel = $('diagnostics-panel');
  if (panel.hidden) return;
  const data = diagnosticsSnapshot();
  const root = $('diagnostics-content');
  root.replaceChildren();
  const header = elem('p', 'diagnostic-line', data.peerCount ? `设备：${data.peerCount} · 可传：${data.peers.filter(peer => peer.canTransfer).length}` : '尚无其他设备');
  root.append(header);
  for (const peer of data.peers) {
    const line = elem('p', 'diagnostic-line');
    line.append(elem('strong', '', `设备 ${peer.device}  `));
    line.append(document.createTextNode(`${peer.connection} / ${peer.ice} / ${peer.channel} · ${peer.reason || '等待连接'}`));
    root.append(line);
  }
}
$('toggle-diagnostics').addEventListener('click', () => {
  const panel = $('diagnostics-panel');
  panel.hidden = !panel.hidden;
  $('toggle-diagnostics').setAttribute('aria-expanded', String(!panel.hidden));
  renderDiagnostics();
});
$('copy-diagnostics').addEventListener('click', async () => {
  const report = JSON.stringify(diagnosticsSnapshot(), null, 2);
  try { await navigator.clipboard.writeText(report); feedback('诊断已复制'); }
  catch { feedback('复制未成功，请截图诊断区域', true); }
});
function renderSentFiles() {
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
    addButton(line, '移除', () => withdrawSharedFile(file.offerId, file.id), 'quiet-button small-button');
    container.append(line);
  }
}
function renderRequests() {
  const root = $('incoming-requests'); root.replaceChildren();
  const offers = [...state.offers.values()];
  $('request-count').textContent = `${offers.reduce((total, offer) => total + offer.files.length, 0)} 个文件`;
  if (!offers.length) { root.append(elem('p', 'empty', '暂无文件')); return; }
  for (const offer of offers) {
    const peer = state.peers.get(offer.peerId);
    const box = elem('div', 'request'); const top = elem('div', 'request-head');
    top.append(elem('strong', '', peer?.name ?? '已离线设备'), elem('small', '', `${offer.files.length} 个文件`));
    box.append(top);
    for (const file of offer.files) {
      const line = elem('div', 'file-row'); line.append(elem('div', 'file-icon', '↧'));
      const info = elem('div', 'item-info'); info.append(elem('strong', '', file.name), elem('span', '', humanSize(file.size)));
      line.append(info);
      if (file.status === 'pending') {
        const button = addButton(line, '接收', () => acceptFile(offer, file));
        button.disabled = !peer?.ready;
      }
      else line.append(elem('span', file.status === 'complete' ? 'chip ready' : 'chip',
        ({ queued: '已加入队列', complete: '已接收', failed: '可在队列重试' })[file.status] || file.status));
      box.append(line);
    }
    const pending = offer.files.filter(f => f.status === 'pending');
    if (pending.length) {
      const foot = elem('div', 'request-footer');
      const button = addButton(foot, `接收全部 (${pending.length})`, () => pending.forEach(f => acceptFile(offer, f)), 'primary small-button');
      button.disabled = !peer?.ready;
      box.append(foot);
    }
    root.append(box);
  }
}
function renderJobs() {
  const root = $('transfer-jobs'); root.replaceChildren();
  if (!state.jobs.length) { root.append(elem('p', 'empty', '暂无任务')); return; }
  for (const job of [...state.jobs].reverse()) {
    const row = elem('div', 'job-row'); row.append(elem('div', 'file-icon', '↓'));
    const middle = elem('div', 'item-info'); middle.append(elem('strong', '', job.name));
    middle.append(elem('span', '', `${job.status} · ${humanSize(job.received)} / ${humanSize(job.size)}`));
    const progress = elem('div', 'progress');
    const bar = elem('div'); bar.style.width = `${job.size ? Math.min(100, job.received / job.size * 100) : (job.url ? 100 : 0)}%`;
    progress.append(bar); middle.append(progress);
    row.append(middle);
    const actions = elem('div', 'job-actions');
    if (job.url) {
      const a = elem('a', 'download-link', '保存'); a.href = job.url; a.download = job.name; actions.append(a);
    } else if (state.active === job || state.queue.includes(job)) {
      addButton(actions, '取消', () => cancelJob(job), 'secondary small-button');
    } else if (job.status.startsWith('失败') || job.status === '已取消') {
      addButton(actions, '重试', () => retryJob(job), 'secondary small-button');
    }
    row.append(actions); root.append(row);
  }
}

$('device-name').value = deviceName();
$('room-device-name').value = deviceName();
$('my-device-label').textContent = deviceName();
$('device-name').addEventListener('input', updateDeviceAvatar);
$('device-name').addEventListener('change', () => saveDeviceName('device-name'));
updateDeviceAvatar();
function toggleNameEditor(visible) {
  $('name-editor-panel').hidden = !visible;
  $('edit-device-name').setAttribute('aria-expanded', String(visible));
  if (visible) {
    $('room-device-name').value = deviceName();
    $('room-device-name').focus();
    $('room-device-name').select();
  }
}
$('edit-device-name').onclick = () => toggleNameEditor($('name-editor-panel').hidden);
$('cancel-device-name').onclick = () => toggleNameEditor(false);
$('save-device-name').onclick = () => {
  if (saveDeviceName('room-device-name')) {
    toggleNameEditor(false);
    feedback('设备名称已保存');
  }
};
$('room-device-name').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('save-device-name').click(); }
  if (event.key === 'Escape') toggleNameEditor(false);
});
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
if (priorSession?.code && /^[A-Z0-9]{4,16}$/.test(priorSession.code)) {
  codeInput.value = priorSession.code;
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
$('enter-room').onclick = () => {
  try {
    const code = normalizeRoomCode(codeInput.value);
    const name = saveDeviceName('device-name');
    if (!name) return;
    const action = { type: 'enter', code, name };
    const session = remembered();
    if (session?.code === code) { action.id = session.id; action.token = session.token; }
    connect(action);
  } catch (e) { feedback(e.message, true); }
};
$('leave-room').onclick = () => {
  if (state.active && !confirm('当前有文件正在传输，退出将中断此任务。确定退出？')) return;
  state.leaving = true;
  sessionStorage.removeItem('lan-room-session');
  for (const job of state.jobs) if (job.url) URL.revokeObjectURL(job.url);
  state.jobs = []; state.queue = []; state.active = null; state.offers.clear(); state.outbound.clear();
  state.ownOffers = [];
  state.ws?.close(); state.ws = null;
  for (const peer of state.peers.values()) peer.pc.close(); state.peers.clear();
  state.code = '';
  showRoom(false); renderPeers(); renderSentFiles(); feedback('已退出房间');
};
$('copy-code').onclick = async () => { try { await navigator.clipboard.writeText(state.code); feedback('房间码已复制'); } catch { feedback(`房间码：${state.code}`); } };
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
