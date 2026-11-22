import { buildPlatform } from './app.js';
import { createLogger } from './lib/logger.js';

/**
 * Entry point for the new kiosk platform (kiosk API + Demo POS).
 *
 * Runs on its own port, separate from the Version 3 app on 3001, so the
 * working V3 demo keeps running while Phase 2 rewires the React UI onto these
 * endpoints. Nothing about V3 is disabled by starting this.
 */
const logger = createLogger({ service: 'kiosk-platform' });
const port = Number(process.env.PLATFORM_PORT ?? 4001);

let platform;
try {
  platform = buildPlatform({ logger });
} catch (error) {
  logger.error('platform.boot_failed', { message: error.message });
  process.stderr.write(`\nFailed to start: ${error.message}\n\n`);
  process.exit(1);
}

const server = platform.app.listen(port, '0.0.0.0', () => {
  logger.info('platform.listening', { port });
  process.stdout.write(
    `\n  Kiosk platform ready\n` +
    `    Kiosk API      http://localhost:${port}/api/kiosk/menu\n` +
    `    Kiosk health   http://localhost:${port}/api/kiosk/health\n` +
    `    Demo POS API   http://localhost:${port}/demo-pos/api/health\n` +
    `    Ops exceptions http://localhost:${port}/api/ops/exceptions\n\n`,
  );
  if (platform.importSummary?.found) {
    const s = platform.importSummary;
    process.stdout.write(
      `  Imported from Version 3: ${s.orders} orders, ${s.items} items, ` +
      `${s.loyaltyAccounts} reward accounts (backup: ${s.backup ?? 'none'})\n\n`,
    );
  }
});

/** Close in-flight work before exiting so no partial write is left behind. */
function shutdown(signal) {
  logger.info('platform.shutdown', { signal });
  server.close(() => {
    platform.close();
    process.exit(0);
  });
  // Do not hang forever if a connection refuses to close.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
