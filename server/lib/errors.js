/**
 * One error model for the whole API.
 *
 * Every failure response has the same shape:
 *   { error: { code, message, details?, requestId? } }
 *
 * `code` is a stable machine-readable string the UI switches on; `message` is
 * safe to show a customer. Internal detail (stack traces, SQL text, file paths)
 * is logged, never returned — a kiosk screen facing the public must not leak
 * the server's internals.
 */

export class AppError extends Error {
  constructor(code, message, { status = 400, details = undefined, cause = undefined, retryable = false } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }

  toResponse(requestId) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

export const badRequest = (message, details) => new AppError('bad_request', message, { status: 400, details });
export const validationFailed = (message, details) => new AppError('validation_failed', message, { status: 422, details });
export const unauthorized = (message = 'Authentication required.') => new AppError('unauthorized', message, { status: 401 });
export const forbidden = (message = 'You do not have access to this action.') => new AppError('forbidden', message, { status: 403 });
export const notFound = (message = 'Not found.') => new AppError('not_found', message, { status: 404 });
export const conflict = (message, details) => new AppError('conflict', message, { status: 409, details });
export const tooManyRequests = (message = 'Too many requests. Please slow down.') =>
  new AppError('rate_limited', message, { status: 429, retryable: true });

/** The POS could not be reached or answered badly. Retryable by design. */
export const posUnavailable = (message = 'The till system is not responding.', details) =>
  new AppError('pos_unavailable', message, { status: 503, details, retryable: true });

/** A product or modifier went away or sold out between browsing and checkout. */
export const menuChanged = (message, details) => new AppError('menu_changed', message, { status: 409, details });

/** Server-recomputed total disagreed with what the client presented. */
export const quoteMismatch = (message, details) => new AppError('quote_mismatch', message, { status: 409, details });

export const internal = (message = 'Something went wrong on our side.', cause) =>
  new AppError('internal_error', message, { status: 500, cause });
