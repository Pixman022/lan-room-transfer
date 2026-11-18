export const DEVICE_NAME_KEY = 'lan-room-device-name';

const colors = [
  'Amber', 'Blue', 'Coral', 'Golden', 'Ivory', 'Lilac', 'Peach', 'Rose',
  'Ruby', 'Silver', 'Sky', 'Teal', 'Violet', 'White', 'Indigo', 'Copper',
];
const animals = [
  'Bear', 'Cat', 'Deer', 'Dolphin', 'Fox', 'Koala', 'Otter', 'Owl',
  'Panda', 'Penguin', 'Rabbit', 'Sparrow', 'Tiger', 'Whale', 'Wolf', 'Zebra',
];
const animalIcons = {
  Bear: '🐻', Cat: '🐱', Deer: '🦌', Dolphin: '🐬', Fox: '🦊', Koala: '🐨',
  Otter: '🦦', Owl: '🦉', Panda: '🐼', Penguin: '🐧', Rabbit: '🐰',
  Sparrow: '🐦', Tiger: '🐯', Whale: '🐳', Wolf: '🐺', Zebra: '🦓',
};
// Old versions generated Chinese label + four digits. Migrate those defaults,
// but keep user-edited names (including manually chosen Chinese names) intact.
const legacyGeneratedName = /^(?:海豚|云雀|松鼠|流星|银杏|星河|海风|山岚|晨光|蓝鲸)-\d{4}$/;

// Friendly display names, never authentication credentials.
export function generateDeviceName(random = Math.random) {
  const color = colors[Math.floor(random() * colors.length)];
  const animal = animals[Math.floor(random() * animals.length)];
  return `${color} ${animal}`;
}

export function deviceAvatar(name) {
  const animal = String(name).trim().split(/\s+/).at(-1);
  return animalIcons[animal] || '🐾';
}

export function getOrCreateDeviceName(storage, random = Math.random) {
  let saved;
  try { saved = storage?.getItem(DEVICE_NAME_KEY); }
  catch { /* Browser storage may be disabled. */ }
  if (typeof saved === 'string' && saved.trim() && saved.trim().length <= 40 &&
      !legacyGeneratedName.test(saved.trim())) {
    return saved.trim();
  }
  const generated = generateDeviceName(random);
  try { storage?.setItem(DEVICE_NAME_KEY, generated); }
  catch { /* Continue with an in-memory name. */ }
  return generated;
}
