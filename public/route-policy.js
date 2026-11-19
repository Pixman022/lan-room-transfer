/** Restricted P2P mode: prefer selected host/host ICE pairs; allow a narrowly
 * verified host/prflx pair when the other endpoint already confirmed its path.
 * Reject public/unsupported addresses and mismatched visible private subnets.
 * This DOES NOT prove a physical LAN; VPNs and routed private networks may
 * still carry traffic outside it. No file bytes are relayed by the server.
 */
// ICE candidates may end immediately after "typ host" (without extension attributes).
// Keep the filter host-only; it does not by itself prove a local network route.
export function isHostCandidateLine(raw) {
  return typeof raw === 'string' && raw.startsWith('candidate:') && /\btyp host\b/.test(raw);
}

export function parseIPv4(address) {
  if (typeof address !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return null;
  const octets = address.split('.').map(Number);
  if (octets.some(n => n > 255)) return null;
  return octets;
}

export function isRFC1918(a) {
  return a && (a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168));
}

// Diagnostics report categories, never hostnames or IP addresses.
export function candidateAddressKind(candidate) {
  if (!candidate) return 'unavailable';
  const address = candidate.address ?? candidate.ip;
  if (typeof address !== 'string' || !address) return 'hidden';
  if (address === '0.0.0.0' || address === '::') return 'redacted';
  if (address.toLowerCase().endsWith('.local')) return 'mdns';
  const ipv4 = parseIPv4(address);
  if (ipv4) return isRFC1918(ipv4) ? 'private-ipv4' : 'other-ipv4';
  if (address.includes(':')) return 'ipv6';
  return 'hostname';
}
function result(allowed, code, reason, local, remote) {
  return {
    allowed, code, reason,
    localAddressKind: candidateAddressKind(local),
    remoteAddressKind: candidateAddressKind(remote),
    localCandidateType: local?.candidateType ?? 'unavailable',
    remoteCandidateType: remote?.candidateType ?? 'unavailable',
  };
}

export function assessPair(local, remote, { allowPeerReflexive = false, remoteHostPairVerified = false } = {}) {
  if (!local || !remote)
    return result(false, 'stats-unavailable', '浏览器没有提供完整的候选统计信息，无法验证局域网路径', local, remote);
  const hostPair = local.candidateType === 'host' && remote.candidateType === 'host';
  const reflexivePair = local.candidateType === 'host' && remote.candidateType === 'prflx';
  if (!hostPair && !reflexivePair)
    return result(false, 'non-host', '实际连接不是已确认的双端 host 直连', local, remote);
  if (reflexivePair && !allowPeerReflexive)
    return result(false, 'prflx-unverified', '对端反射候选尚未满足受限直连验证条件', local, remote);

  const localKind = candidateAddressKind(local);
  const remoteKind = candidateAddressKind(remote);
  const obscured = kind => ['mdns', 'hidden', 'redacted'].includes(kind);
  const kinds = [localKind, remoteKind];
  // Never allow an explicitly visible public/unsupported address simply because
  // the other candidate was masked. Known non-local cases remain blocked.
  if (kinds.some(kind => kind !== 'private-ipv4' && !obscured(kind))) {
    if (kinds.includes('ipv6'))
      return result(false, 'ipv6-unsupported', '连接使用了可见 IPv6 地址，当前不支持', local, remote);
    return result(false, 'unsupported-address', '连接包含可见的非私有 IPv4 地址，拒绝传输', local, remote);
  }
  if (kinds.every(kind => kind === 'private-ipv4')) {
    const a = parseIPv4(local.address ?? local.ip);
    const b = parseIPv4(remote.address ?? remote.ip);
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2])
      return result(false, 'subnet-mismatch', '连接两端不在相同的私有 IPv4 /24 网段', local, remote);
    if (a.every((v, i) => v === b[i]))
      return result(false, 'same-address', '两端地址相同，原型不验证同一设备的标签页传输', local, remote);
    return reflexivePair
      ? result(true, 'private-ipv4-host-prflx-pair',
        '已验证私有 IPv4 host/prflx 直连；不能保证流量仅经过局域网', local, remote)
      : result(true, 'private-ipv4-host-pair',
        '已建立私有 IPv4 host P2P 连接（不保证流量仅经过局域网）', local, remote);
  }
  if (reflexivePair) {
    // A fully masked pair requires a route-verified host/host declaration from
    // the remote endpoint in addition to the local ICE/DTLS/channel checks.
    if (obscured(localKind) && obscured(remoteKind) && remoteHostPairVerified)
      return result(true, 'masked-host-prflx-reciprocal-p2p',
        '对端确认 host/host 直连；双方地址被隐藏，无法保证仅经过物理局域网', local, remote);
    // Otherwise the host endpoint must expose a private IPv4 address.
    if (localKind !== 'private-ipv4' || !obscured(remoteKind))
      return result(false, 'prflx-unverified', '无法确认反射候选对应的私有 IPv4 直连路径', local, remote);
    return result(true, 'masked-host-prflx-p2p',
      '已验证 host/prflx 直连；对端地址被隐藏，不能保证流量仅经过局域网', local, remote);
  }
  // A selected host/host pair may hide addresses under the approved policy.
  return result(true, 'masked-host-p2p',
    '已建立 host P2P 连接；浏览器隐藏地址，不能保证只经过局域网', local, remote);
}

export async function inspectSelectedPath(pc, {
  remoteReady = false, remoteHostPairVerified = false, channelOpen = false,
} = {}) {
  const report = await pc.getStats();
  const entries = [...report.values()];
  let pair;
  let selectedByTransport = false;
  for (const stat of entries) {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) {
      pair = report.get(stat.selectedCandidatePairId);
      if (pair) { selectedByTransport = true; break; }
    }
  }
  if (!pair) pair = entries.find(s => s.type === 'candidate-pair' && s.selected === true && s.state === 'succeeded');
  if (!pair || !pair.localCandidateId || !pair.remoteCandidateId) {
    return { ...assessPair(null, null), code: 'pair-unavailable', reason: '浏览器尚未公开已选择的 ICE 候选连接对' };
  }
  const local = report.get(pair.localCandidateId);
  const remote = report.get(pair.remoteCandidateId);
  // Some browsers omit "nominated" in getStats(). The transport's selected
  // pair ID (or Firefox's explicit selected flag) is evidence of the actively
  // selected pair; never override an explicitly false nominated flag.
  const selectedAndNominated = pair.nominated === true ||
    (pair.nominated == null && (selectedByTransport || pair.selected === true));
  const verifiedReflexive = local?.candidateType === 'host' && remote?.candidateType === 'prflx' &&
    pair.state === 'succeeded' && selectedAndNominated &&
    pc.connectionState === 'connected' &&
    ['connected', 'completed'].includes(pc.iceConnectionState) &&
    channelOpen && remoteReady;
  const verdict = assessPair(local, remote, {
    allowPeerReflexive: verifiedReflexive,
    remoteHostPairVerified: verifiedReflexive && remoteHostPairVerified,
  });
  // Only issue a host/host attestation if the browser reports the selected
  // successful pair and an established transport. Never send candidate IPs.
  const hostHostVerified = verdict.allowed &&
    local?.candidateType === 'host' && remote?.candidateType === 'host' &&
    pair.state === 'succeeded' && selectedAndNominated &&
    pc.connectionState === 'connected' &&
    ['connected', 'completed'].includes(pc.iceConnectionState) && channelOpen;
  // No IPs, hostnames, ports, ICE IDs or credentials in normal diagnostics.
  const reflexiveEvidence = local?.candidateType === 'host' && remote?.candidateType === 'prflx'
    ? {
      pairState: pair.state ?? 'unavailable',
      nominated: pair.nominated === true ? 'yes' : pair.nominated === false ? 'no' : 'missing',
      selectedByTransport, selectedByPairFlag: pair.selected === true,
      remoteReady, remoteHostPairVerified, channelOpen,
      localAddressKind: verdict.localAddressKind, remoteAddressKind: verdict.remoteAddressKind,
    } : null;
  return { ...verdict, hostHostVerified, reflexiveEvidence };
}
