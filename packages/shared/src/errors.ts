/**
 * A single error taxonomy shared by all three services.
 *
 * Two properties matter more than the class hierarchy itself:
 *
 *  - Every error carries an explicit HTTP status and a stable machine-readable
 *    `code`. Clients branch on `code`, never on prose, so error messages stay
 *    free to change without breaking a consumer.
 *
 *  - `expose` separates errors that are safe to describe to a caller from ones
 *    that are not. A validation failure should tell the client exactly what was
 *    wrong; a database failure must not leak a connection string or schema
 *    detail. Anything unexpected is reported as a generic 500 while the real
 *    cause goes to the logs.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  correlationId?: string;
  errors?: Array<{ path: string; message: string }>;
  /**
   * An RFC 9457 extension member: what the caller could do next. Present only
   * where there is a genuinely useful next step, so its absence never has to be
   * interpreted — `detail` says what went wrong, `hint` says where to go.
   */
  hint?: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Whether `message` is safe to return to the caller. */
  readonly expose: boolean;
  readonly details?: Array<{ path: string; message: string }>;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: {
      expose?: boolean;
      cause?: unknown;
      details?: Array<{ path: string; message: string }>;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.expose = options.expose ?? status < 500;
    if (options.details) this.details = options.details;
    Error.captureStackTrace?.(this, new.target);
  }

  static validation(message: string, details?: Array<{ path: string; message: string }>) {
    return new AppError('VALIDATION_ERROR', 400, message, details ? { details } : {});
  }

  static unauthorized(message = 'Authentication required') {
    return new AppError('UNAUTHORIZED', 401, message);
  }

  static invalidCredentials() {
    // Deliberately identical whether the email is unknown or the password is
    // wrong. Distinguishing them turns the login endpoint into an oracle for
    // enumerating which email addresses have accounts.
    return new AppError('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }

  static tokenExpired(message = 'Token has expired') {
    return new AppError('TOKEN_EXPIRED', 401, message);
  }

  static tokenInvalid(message = 'Token is invalid') {
    return new AppError('TOKEN_INVALID', 401, message);
  }

  static forbidden(message = 'You do not have access to this resource') {
    return new AppError('FORBIDDEN', 403, message);
  }

  static notFound(resource = 'Resource') {
    return new AppError('NOT_FOUND', 404, `${resource} not found`);
  }

  static conflict(message: string) {
    return new AppError('CONFLICT', 409, message);
  }

  static rateLimited(message = 'Too many requests') {
    return new AppError('RATE_LIMITED', 429, message);
  }

  static upstreamUnavailable(service: string, cause?: unknown) {
    return new AppError('UPSTREAM_UNAVAILABLE', 503, `${service} is unavailable`, {
      expose: true,
      cause,
    });
  }

  static internal(message: string, cause?: unknown) {
    return new AppError('INTERNAL_ERROR', 500, message, { expose: false, cause });
  }
}

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Validation Failed',
  UNAUTHORIZED: 'Unauthorized',
  INVALID_CREDENTIALS: 'Invalid Credentials',
  TOKEN_EXPIRED: 'Token Expired',
  TOKEN_INVALID: 'Invalid Token',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not Found',
  CONFLICT: 'Conflict',
  RATE_LIMITED: 'Too Many Requests',
  UPSTREAM_UNAVAILABLE: 'Service Unavailable',
  INTERNAL_ERROR: 'Internal Server Error',
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Returned instead of any real message whenever detail is not safe to expose. */
const GENERIC_DETAIL = 'An unexpected error occurred';

/**
 * Convert any thrown value into an RFC 9457 problem document.
 *
 * Unknown errors collapse to a generic 500 with no detail: the caller learns
 * that something failed and the correlation id to quote, and nothing else.
 */
export function toProblemDetails(error: unknown, correlationId?: string): ProblemDetails {
  if (isAppError(error)) {
    const problem: ProblemDetails = {
      type: `https://trams.local/errors/${error.code.toLowerCase().replace(/_/g, '-')}`,
      title: TITLES[error.code],
      status: error.status,
      code: error.code,
    };
    // A non-exposed error still gets a detail field, just a generic one. The
    // response shape must not depend on whether the message happened to be
    // safe to share — a client parsing errors would otherwise see `detail`
    // present on some 500s and absent on others.
    problem.detail = error.expose ? error.message : GENERIC_DETAIL;
    if (error.details) problem.errors = error.details;
    if (correlationId) problem.correlationId = correlationId;
    return problem;
  }

  const problem: ProblemDetails = {
    type: 'https://trams.local/errors/internal-error',
    title: TITLES.INTERNAL_ERROR,
    status: 500,
    code: 'INTERNAL_ERROR',
    detail: GENERIC_DETAIL,
  };
  if (correlationId) problem.correlationId = correlationId;
  return problem;
}
