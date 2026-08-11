const CHARACTER_GROUPS = [
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  'abcdefghijkmnopqrstuvwxyz',
  '23456789',
  '!@#$%^&*()-_=+',
] as const;

const ALL_CHARACTERS = CHARACTER_GROUPS.join('');
const UINT32_RANGE = 0x1_0000_0000;

function secureRandomIndex(crypto: Crypto, maximum: number): number {
  const unbiasedLimit = Math.floor(UINT32_RANGE / maximum) * maximum;
  const buffer = new Uint32Array(1);
  let value: number;

  do {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? 0;
  } while (value >= unbiasedLimit);

  return value % maximum;
}

export default function generateStrongCredential(length = 32): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new Error('Secure random number generation is unavailable.');
  if (!Number.isInteger(length) || length < CHARACTER_GROUPS.length) {
    throw new RangeError(`Credential length must be at least ${CHARACTER_GROUPS.length}.`);
  }

  const characters = CHARACTER_GROUPS.map((group) => group.charAt(secureRandomIndex(crypto, group.length)));

  while (characters.length < length) {
    characters.push(ALL_CHARACTERS.charAt(secureRandomIndex(crypto, ALL_CHARACTERS.length)));
  }

  for (let current = characters.length - 1; current > 0; current -= 1) {
    const target = secureRandomIndex(crypto, current + 1);
    [characters[current], characters[target]] = [characters[target] ?? '', characters[current] ?? ''];
  }

  return characters.join('');
}
