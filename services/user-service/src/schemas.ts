import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './domain/password.js';

/**
 * Request validation schemas.
 *
 * Validation happens at the service boundary, not only at the gateway. The
 * gateway validates too, but a service that trusts its caller is a service that
 * breaks the moment anything else calls it — a future internal client, a
 * misconfigured proxy rule, or a test harness. Every service validates its own
 * input.
 */

const email = z
  .string()
  .trim()
  .min(3)
  .max(254) // RFC 5321 maximum
  .email('Must be a valid email address')
  .toLowerCase();

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

const name = z.string().trim().min(1, 'Name is required').max(200);

export const registerSchema = z.object({
  email,
  password,
  name,
});

export const loginSchema = z.object({
  email,
  // Not length-validated on login. Applying the registration policy here would
  // reject a legacy password outright and, worse, would tell an attacker that
  // their guess failed policy rather than failed authentication.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
  allSessions: z.boolean().optional().default(false),
});

export const updateProfileSchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
  })
  // Reject `{}` explicitly rather than treating it as a successful no-op, so a
  // client with a bug gets told about it instead of seeing 200s that do nothing.
  .refine((value) => value.name !== undefined || value.email !== undefined, {
    message: 'Provide at least one of: name, email',
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'currentPassword is required'),
    newPassword: password,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });

export const listUsersQuerySchema = z.object({
  // Coerced because query strings are always strings. The limit is capped at
  // 100 so a caller cannot request the entire table in one query.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const userIdParamSchema = z.object({
  id: z.string().uuid('Must be a valid UUID'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
