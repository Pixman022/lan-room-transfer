/** A deliberately conservative research gate, not an OS-level LAN guarantee.
 * Reject if the browser hides addresses, if a relay is involved, if an IPv6/VPN
 * address is observed, or if private IPv4 peers aren't in the same /24.
 * A private /24 match still cannot prove a physical LAN; see docs/limitations.md.
 */
export function parseIPv4(address) {
  if (typeof address !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return null;
  const octets = address.split('.').map(Number);
  if (octets.some(n => n > 255)) return null;
  return octets;
}

export function isRFC1918(a) {
  return a && (a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168));
}

export function assessPair(local, remote) {
  if (!local || !remote || local.candidateType !== 'host' || remote.candidateType !== 'host') {
    return { allowed: false, reason: '实际连接不是已确认的双端 host 直连' };
  }
  const a = parseIPv4(local.address ?? local.ip);
  const b = parseIPv4(remote.address ?? remote.ip);
  if (!isRFC1918(a) || !isRFC1918(b)) {
    return { allowed: false, reason: '浏览器未提供可核实的私有 IPv4 地址，或使用了不受支持的网络' };
  }
  if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
    return { allowed: false, reason: '连接两端不在相同的私有 IPv4 /24 网段' };
  }
  if (a.every((value, index) => value === b[index])) {
    return { allowed: false, reason: '两端地址相同，原型不验证同一设备的标签页传输' };
  }
  return { allowed: true, reason: '候选地址满足保守 /24 检查（不代表已证明物理 LAN 路由）' };
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
    return { allowed: false, reason: '浏览器尚未公开已选择的 ICE 候选连接对' };
  }
  return assessPair(report.get(pair.localCandidateId), report.get(pair.remoteCandidateId));
}
