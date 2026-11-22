import { unauthorized, forbidden } from '../lib/errors.js';

/**
 * Demo POS authentication.
 *
 * Sessions are resolved from SQLite, not an in-memory map, so a restart during
 * service does not log every employee out mid-shift — which is what Version 3
 * did. Tokens are stored only as a SHA-256 digest.
 */
export function posAuth(store) {
  return (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = store.resolveSession(token);
    if (!user) return next(unauthorized('Till login required.'));
    req.posUser = user;
    req.posToken = token;
    return next();
  };
}

/** Role gate. Read-only accounts can look but not change anything. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.posUser) return next(unauthorized('Till login required.'));
    if (!roles.includes(req.posUser.role)) {
      return next(forbidden(`This action needs one of: ${roles.join(', ')}.`));
    }
    return next();
  };
}
