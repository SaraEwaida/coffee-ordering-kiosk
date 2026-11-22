/**
 * Structured JSON logging to stdout.
 *
 * One JSON object per line so logs stay greppable on the kiosk and can be
 * shipped later without a parser rewrite. Secrets are redacted by key name
 * before anything is written — a bearer token or gift-card code must never
 * reach a log file, even when an error payload is spread into the entry.
 */

const REDACT_KEYS = new Set([
  'password', 'pin', 'token', 'authorization', 'secret', 'card', 'pan', 'cvv',
  'cvc', 'track', 'giftcardcode', 'giftcode', 'code', 'passwordhash',
  'passwordsalt', 'clientsecret', 'apikey',
]);

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function isSecretKey(key) {
  return REDACT_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''));
}

function redact(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const output = {};
  for (const [key, inner] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? '[redacted]' : redact(inner, depth + 1);
  }
  return output;
}

export function createLogger({ level = process.env.LOG_LEVEL || 'info', service = 'kiosk', stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(entryLevel, event, context) {
    if (LEVELS[entryLevel] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: entryLevel,
      service,
      event,
      ...redact(context ?? {}),
    });
    stream.write(`${line}\n`);
  }

  const logger = {
    level,
    debug: (event, context) => emit('debug', event, context),
    info: (event, context) => emit('info', event, context),
    warn: (event, context) => emit('warn', event, context),
    error: (event, context) => emit('error', event, context),
    child(bindings) {
      return {
        ...logger,
        debug: (event, context) => emit('debug', event, { ...bindings, ...context }),
        info: (event, context) => emit('info', event, { ...bindings, ...context }),
        warn: (event, context) => emit('warn', event, { ...bindings, ...context }),
        error: (event, context) => emit('error', event, { ...bindings, ...context }),
        child: (more) => logger.child({ ...bindings, ...more }),
      };
    },
  };
  return logger;
}

/** A logger that writes nothing — used by tests to keep output readable. */
export const silentLogger = createLogger({ level: 'silent' });
