// The initial suggestion does not reserve a room. The first entrant creates it.
export function generateRandomRoomCode(randomValues = values => crypto.getRandomValues(values)) {
  const bytes = new Uint32Array(1);
  randomValues(bytes);
  return String(bytes[0] % 10000).padStart(4, '0');
}

export function normalizeRoomCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{4,16}$/.test(code)) {
    throw new Error('房间码需要 4–16 位字母或数字');
  }
  return code;
}
