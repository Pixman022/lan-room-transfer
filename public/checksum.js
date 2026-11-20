// Browser WebCrypto is available on the HTTPS production origin and localhost.
// WebCrypto digests an entire ArrayBuffer at once; large files can exhaust browser memory.
export async function sha256Hex(blobOrBuffer) {
  const buffer = blobOrBuffer instanceof ArrayBuffer ? blobOrBuffer : await blobOrBuffer.arrayBuffer();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export async function verifySha256(blobOrBuffer, expected) {
  return isSha256Hex(expected) && (await sha256Hex(blobOrBuffer)) === expected;
}
