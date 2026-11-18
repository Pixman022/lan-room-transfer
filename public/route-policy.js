/** A deliberately conservative research gate, not an OS-level LAN guarantee.
 * Reject if the browser hides addresses, if a relay is involved, if an IPv6/VPN
 * address is observed, or if private IPv4 peers aren't in the same /24.
 * A private /24 match still cannot prove a physical LAN; see docs/limitations.md.
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

export function assessPair(local, remote) {
  if (!local || !remote)
    return result(false, 'stats-unavailable', '浏览器没有提供完整的候选统计信息，无法验证局域网路径', local, remote);
  if (local.candidateType !== 'host' || remote.candidateType !== 'host')
    return result(false, 'non-host', '实际连接不是已确认的双端 host 直连', local, remote);

  const localKind = candidateAddressKind(local);
  const remoteKind = candidateAddressKind(remote);
  if (localKind !== 'private-ipv4' || remoteKind !== 'private-ipv4') {
    const kinds = [localKind, remoteKind];
    if (kinds.includes('mdns'))
      return result(false, 'mdns-obfuscated', '浏览器使用 mDNS 隐藏了候选地址，无法验证双方是否在同一网段', local, remote);
    if (kinds.some(k => k === 'hidden' || k === 'redacted'))
      return result(false, 'address-hidden', '浏览器隐藏了候选 IP 地址，无法验证双方是否在同一网段', local, remote);
    if (kinds.includes('ipv6'))
      return result(false, 'ipv6-unsupported', '连接使用了 IPv6 地址，当前只验证私有 IPv4 网段', local, remote);
    return result(false, 'unsupported-address', '连接候选不是受支持的私有 IPv4 地址，无法验证局域网路径', local, remote);
  }
  const a = parseIPv4(local.address ?? local.ip);
  const b = parseIPv4(remote.address ?? remote.ip);
  if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2])
    return result(false, 'subnet-mismatch', '连接两端不在相同的私有 IPv4 /24 网段', local, remote);
  if (a.every((v, i) => v === b[i]))
    return result(false, 'same-address', '两端地址相同，原型不验证同一设备的标签页传输', local, remote);
  return result(true, 'private-ipv4-host-pair',
    '候选地址满足保守 /24 检查（不代表已证明物理 LAN 路由）', local, remote);
}

export async function inspectSelectedPath(pc) {
  const report = await pc.getStats();
  const entries = [...report.values()];
  let pair;
  for (const stat of entries) {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) {
      pair = report.get(stat.selectedCandidatePairId);
      if (pair) break;
    }
  }
  if (!pair) pair = entries.find(s => s.type === 'candidate-pair' && s.selected === true && s.state === 'succeeded');
  if (!pair || !pair.localCandidateId || !pair.remoteCandidateId) {
    return { ...assessPair(null, null), code: 'pair-unavailable', reason: '浏览器尚未公开已选择的 ICE 候选连接对' };
  }
  return assessPair(report.get(pair.localCandidateId), report.get(pair.remoteCandidateId));
}
