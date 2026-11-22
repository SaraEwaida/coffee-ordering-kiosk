import { randomUUID } from 'node:crypto';
import { AppError, internal } from '../lib/errors.js';

/** Attach a request ID so a customer-visible error can be traced in the logs. */
export function requestId() {
  return (req, res, next) => {
    req.requestId = req.get('x-request-id')?.slice(0, 64) || randomUUID();
    res.set('x-request-id', req.requestId);
    next();
  };
}

/** Kiosk responses must never be cached by a browser or a proxy. */
export function noStore() {
  return (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
}

export function notFoundHandler() {
  return (req, res) => {
    res.status(404).json({
      error: { code: 'not_found', message: `No route for ${req.method} ${req.path}`, requestId: req.requestId },
    });
  };
}

/**
 * Terminal error handler.
 *
 * Internal detail is logged, never returned: a kiosk screen faces the public,
 * so a stack trace or SQL fragment on it is both a bad experience and an
 * information leak. Expected failures keep their own message and code.
 */
export function errorHandler({ logger }) {
  return (error, req, res, _next) => {
    let appError = error;

    if (error instanceof SyntaxError && 'body' in error) {
      appError = new AppError('bad_request', 'The request body was not valid JSON.', { status: 400 });
    } else if (!(error instanceof AppError)) {
      appError = internal('Something went wrong. Please try again or ask a member of staff.', error);
    }

    const level = appError.status >= 500 ? 'error' : 'warn';
    logger?.[level]?.('http.error', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: appError.status,
      code: appError.code,
      message: appError.message,
      // The original message and stack go to the log only.
      internal: appError.status >= 500 ? { message: error.message, stack: error.stack } : undefined,
    });

    if (res.headersSent) return;
    res.status(appError.status).json(appError.toResponse(req.requestId));
  };
}
