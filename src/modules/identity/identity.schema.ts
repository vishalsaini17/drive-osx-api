import { z } from 'zod';

/**
 * Passwords arrive already hashed from some clients, so the minimum is a
 * length check rather than a composition policy — strength is enforced in the
 * client's own password rules.
 */
const secret = z.string().min(8, 'Password must be at least 8 characters');

export const registerSchema = z
  .object({
    username: z.string().trim().min(3, 'Username must be at least 3 characters').max(32),
    password: secret,
    firstName: z.string().trim().min(1, 'First name is required').max(60),
    lastName: z.string().trim().min(1, 'Last name is required').max(60),
    recoveryEmail: z.string().trim().email('Enter a valid email address').optional().or(z.literal('')),
    mobile: z.string().trim().min(6).max(20).optional().or(z.literal('')),
  })
  .refine((value) => Boolean(value.recoveryEmail || value.mobile), {
    message: 'Provide at least one recovery method: an email address or a phone number',
    path: ['recoveryEmail'],
  });

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export const mailAuthSchema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().min(1, 'Enter your username or email address'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: secret,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: secret,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  recoveryEmail: z.string().trim().email().optional(),
  mobile: z.string().trim().min(6).max(20).optional(),
  avatarUrl: z.string().trim().max(500).optional(),
});

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
