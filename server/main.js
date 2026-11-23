import { buildPlatform } from './app.js';
import { createLogger } from './lib/logger.js';
import { DEFAULT_PLATFORM_PORT } from './services/receipts.js';

/**
 * Entry point for the new kiosk platform (kiosk API + Demo POS).
 *
 * Runs on its own port, separate from the Version 3 app on 3001, so the
 * working V3 demo keeps running while Phase 2 rewires the React UI onto these
 * endpoints. Nothing about V3 is disabled by starting this.
 */
const logger = createLogger({ service: 'kiosk-platform' });
const port = Number(process.env.PLATFORM_PORT ?? DEFAULT_PLATFORM_PORT);

let platform;
try {
  platform = buildPlatform({ logger });
} catch (error) {
  logger.error('platform.boot_failed', { message: error.message });
  process.stderr.write(`\nFailed to start: ${error.message}\n\n`);
  process.exit(1);
}

const server = platform.app.listen(port, '0.0.0.0');

/**
 * A failed bind must say what is wrong, not crash in the success path.
 *
 * The usual cause is a previous `npm run dev` still running and holding the
 * port. That deserves one clear sentence, not a stack trace.
 */
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error('platform.port_in_use', { port });
    process.stderr.write(
      `\n  Port ${port} is already in use.\n\n` +
      `  Another copy of the platform is probably still running — an earlier\n` +
      `  'npm run dev' that was closed without stopping, most often.\n\n` +
      `  Windows:  netstat -ano | findstr :${port}\n` +
      `            taskkill /PID <pid> /F\n\n` +
      `  Or start this one somewhere else:\n` +
      `            $env:PLATFORM_PORT=${port + 1}; npm run dev\n\n`,
    );
  } else {
    logger.error('platform.listen_failed', { port, code: error.code, message: error.message });
    process.stderr.write(`\n  Could not start on port ${port}: ${error.message}\n\n`);
  }
  process.exit(1);
});

server.on('listening', () => {
  // address() is null unless the socket actually bound, so never dereference
  // it blindly: on a failed bind that turns a clear port conflict into an
  // unrelated TypeError. The configured port is the fallback.
  const boundPort = server.address()?.port ?? port;
  logger.info('platform.listening', { port: boundPort });

  // Only now is the port certain. Receipt QR codes are built from this, so
  // binding it here rather than guessing is what keeps a scanned code
  // pointing at a server that exists.
  const receiptOriginUrl = platform.receipts.bindPort(boundPort);
  process.stdout.write(
    `\n  Kiosk platform ready\n` +
    `    Kiosk API      http://localhost:${boundPort}/api/kiosk/menu\n` +
    `    Kiosk health   http://localhost:${boundPort}/api/kiosk/health\n` +
    `    Demo POS API   http://localhost:${boundPort}/demo-pos/api/health\n` +
    `    Ops exceptions http://localhost:${boundPort}/api/ops/exceptions\n` +
    `    Receipts (QR)  ${receiptOriginUrl ?? 'UNAVAILABLE - no LAN address found, QR codes disabled'}\n\n`,
  );
  if (!receiptOriginUrl) {
    logger.warn('receipts.no_reachable_origin', {
      hint: 'Set PUBLIC_RECEIPT_ORIGIN to a URL a phone can reach.',
    });
  }
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
