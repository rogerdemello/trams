import { describe, expect, it } from 'vitest';
import { AppError, isAppError, toProblemDetails } from '@trams/shared';
import { classifySmtpError } from '../../services/notification-service/src/channels/smtp-channel.js';
import { isPermanentFailure } from '../../services/notification-service/src/channels/types.js';

describe('AppError', () => {
  it('exposes 4xx messages and hides 5xx detail', () => {
    // The distinction that keeps internals out of client responses.
    expect(AppError.notFound('User').expose).toBe(true);
    expect(AppError.internal('connection string leaked in here').expose).toBe(false);
  });

  it('gives an identical response for unknown email and wrong password', () => {
    // Distinguishing them turns /login into an account-enumeration oracle.
    const error = AppError.invalidCredentials();

    expect(error.message).toBe('Invalid email or password');
    expect(error.status).toBe(401);
  });

  it('keeps expired and invalid tokens distinct', () => {
    // Actionable difference: refresh versus re-authenticate.
    expect(AppError.tokenExpired().code).toBe('TOKEN_EXPIRED');
    expect(AppError.tokenInvalid().code).toBe('TOKEN_INVALID');
  });

  it('preserves the cause for logging without exposing it', () => {
    const cause = new Error('ECONNREFUSED 127.0.0.1:4001');
    const error = AppError.upstreamUnavailable('user-service', cause);

    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('ECONNREFUSED');
  });
});

describe('toProblemDetails', () => {
  it('renders a validation error with field paths', () => {
    const problem = toProblemDetails(
      AppError.validation('Request validation failed', [
        { path: 'email', message: 'Must be a valid email address' },
      ]),
      'corr-1',
    );

    expect(problem.status).toBe(400);
    expect(problem.code).toBe('VALIDATION_ERROR');
    expect(problem.errors?.[0]?.path).toBe('email');
    expect(problem.correlationId).toBe('corr-1');
  });

  it('collapses an unknown throw into a generic 500', () => {
    // The important assertion in this file. An unexpected error must not leak a
    // stack trace, a file path, or a connection string to a client.
    const problem = toProblemDetails(
      new Error('SQLITE_ERROR: no such table: secret_internal_table'),
      'corr-2',
    );

    expect(problem.status).toBe(500);
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).toBe('An unexpected error occurred');
    expect(JSON.stringify(problem)).not.toContain('secret_internal_table');
    // The correlation id is still returned, so the client has something to
    // quote and an operator can find the real error in the logs.
    expect(problem.correlationId).toBe('corr-2');
  });

  it('omits detail for a non-exposed AppError', () => {
    const problem = toProblemDetails(AppError.internal('internal hostname db-primary-01'));

    expect(problem.detail).toBe('An unexpected error occurred');
    expect(JSON.stringify(problem)).not.toContain('db-primary-01');
  });

  it('handles a thrown non-Error value', () => {
    expect(toProblemDetails('a bare string').status).toBe(500);
    expect(toProblemDetails(null).status).toBe(500);
    expect(toProblemDetails(undefined).code).toBe('INTERNAL_ERROR');
  });
});

describe('isAppError', () => {
  it('distinguishes our errors from foreign ones', () => {
    expect(isAppError(AppError.notFound())).toBe(true);
    expect(isAppError(new Error('nope'))).toBe(false);
    expect(isAppError({ status: 404, code: 'NOT_FOUND' })).toBe(false);
  });
});

describe('classifySmtpError', () => {
  it('treats a 5xx reply as permanent — retrying cannot fix a bad mailbox', () => {
    const error = classifySmtpError({ responseCode: 550, message: 'No such user here' });

    expect(isPermanentFailure(error)).toBe(true);
  });

  it('treats a 4xx reply as transient — this is what retries are for', () => {
    const error = classifySmtpError({ responseCode: 451, message: 'Mailbox busy' });

    expect(isPermanentFailure(error)).toBe(false);
  });

  it('treats a malformed envelope as permanent', () => {
    const error = classifySmtpError({ code: 'EENVELOPE', message: 'No recipients defined' });

    expect(isPermanentFailure(error)).toBe(true);
  });

  it('defaults an unrecognised failure to transient', () => {
    // The safe default: an unnecessary retry costs a little work, whereas
    // wrongly classifying a recoverable failure as permanent loses the
    // notification.
    expect(isPermanentFailure(classifySmtpError({ code: 'ETIMEDOUT' }))).toBe(false);
    expect(isPermanentFailure(classifySmtpError(new Error('socket hang up')))).toBe(false);
    expect(isPermanentFailure(classifySmtpError(undefined))).toBe(false);
  });
});
