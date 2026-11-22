import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Password/PIN hashing for Demo POS staff accounts.
 *
 * scrypt with a per-user random salt. The legacy prototype's demo PIN
 * ("manager"/"123456") was documented in plain text; nothing reversible is
 * stored here. Comparison is constant-time so a wrong PIN cannot be inferred
 * from response timing.
 */

const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 4) {
    throw new Error('Password must be a string of at least 4 characters');
  }
  const hash = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  if (typeof password !== 'string' || typeof hash !== 'string' || typeof salt !== 'string') return false;
  let candidate;
  try {
    candidate = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  } catch {
    return false;
  }
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}

/** Session tokens are stored only as a SHA-256 digest. */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}
