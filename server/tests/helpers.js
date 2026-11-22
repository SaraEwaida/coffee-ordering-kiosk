import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildPlatform } from '../app.js';
import { silentLogger } from '../lib/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build a complete platform for a test: both databases, the Demo POS, the
 * adapter and all services. Tests drive the real objects rather than mocks, so
 * a passing test means the actual SQL, constraints and transactions work.
 *
 * Workers are off by default so tests control retry timing explicitly instead
 * of racing a background interval.
 */
export function makeTestPlatform(options = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-test-'));
  const platform = buildPlatform({
    posDbPath: resolve(dir, 'demo-pos.sqlite'),
    kioskDbPath: resolve(dir, 'kiosk.sqlite'),
    legacyDbPath: resolve(dir, 'does-not-exist.sqlite'),
    logger: silentLogger,
    importLegacy: false,
    startWorkers: false,
    ...options,
  });
  const originalClose = platform.close;
  platform.close = () => {
    originalClose();
    rmSync(dir, { recursive: true, force: true });
  };
  platform.tempDir = dir;
  return platform;
}

/** Start the app on an ephemeral port and return a fetch helper. */
export async function startHttp(platform) {
  const server = await new Promise((done) => {
    const s = platform.app.listen(0, '127.0.0.1', () => done(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { body, token, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: response.status, body: json };
  }

  return {
    base,
    get: (path, options) => call('GET', path, options),
    post: (path, body, options) => call('POST', path, { ...options, body }),
    patch: (path, body, options) => call('PATCH', path, { ...options, body }),
    async managerToken() {
      const result = await call('POST', '/demo-pos/api/auth/login', {
        body: { username: 'manager', password: 'demo-manager-1234' },
      });
      return result.body.accessToken;
    },
    async baristaToken() {
      const result = await call('POST', '/demo-pos/api/auth/login', {
        body: { username: 'barista', password: 'demo-barista-1234' },
      });
      return result.body.accessToken;
    },
    close: () => new Promise((done) => server.close(done)),
  };
}

/** A simple drink that satisfies every required modifier group on a latte. */
export const LATTE_LINE = {
  posProductId: 'PRD-1003',
  quantity: 1,
  modifierIds: ['MOD-SIZE-M', 'MOD-MILK-REG', 'MOD-SUG-0'],
};

export { here as testsDir };
