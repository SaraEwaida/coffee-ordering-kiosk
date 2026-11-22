import { tooManyRequests } from '../lib/errors.js';

/**
 * In-memory sliding-window rate limiter.
 *
 * Adequate for a single-process PoC on one kiosk. A multi-instance deployment
 * needs a shared store; that is called out in docs rather than pretended away.
 * Used on login (credential stuffing) and on code lookups (gift card and
 * loyalty codes are bearer credentials, so guessing must be expensive).
 */
export function rateLimit({ windowSeconds = 600, max = 30, key = (req) => req.ip ?? 'unknown', message } = {}) {
  const hits = new Map();

  function sweep(now) {
    for (const [k, timestamps] of hits) {
      const kept = timestamps.filter((t) => now - t < windowSeconds * 1000);
      if (kept.length === 0) hits.delete(k);
      else hits.set(k, kept);
    }
  }

  let lastSweep = Date.now();

  return (req, _res, next) => {
    const now = Date.now();
    // Sweep occasionally so the map cannot grow without bound on a long-lived
    // kiosk process.
    if (now - lastSweep > windowSeconds * 1000) {
      sweep(now);
      lastSweep = now;
    }
    const k = key(req);
    const timestamps = (hits.get(k) ?? []).filter((t) => now - t < windowSeconds * 1000);
    if (timestamps.length >= max) {
      return next(tooManyRequests(message));
    }
    timestamps.push(now);
    hits.set(k, timestamps);
    return next();
  };
}
