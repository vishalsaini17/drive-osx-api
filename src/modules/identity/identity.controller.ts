import type { Request, Response } from 'express';
import { requireUser } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { parseBody } from '../../platform/http/validate.js';
import * as service from './identity.service.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  mailAuthSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './identity.schema.js';

function metadataOf(req: Request): service.RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

export const register = asyncHandler(async (req: Request, res: Response) => {
  const body = parseBody(registerSchema, req);
  const result = await service.register(
    {
      username: body.username,
      password: body.password,
      firstName: body.firstName,
      lastName: body.lastName,
      recoveryEmail: body.recoveryEmail || undefined,
      mobile: body.mobile || undefined,
    },
    metadataOf(req),
  );

  res.status(201).json({ message: 'Account created successfully', user: result.user });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const body = parseBody(loginSchema, req);
  const result = await service.login(body, metadataOf(req));

  res.json({
    message: 'Login successful',
    token: result.token,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    user: result.user,
  });
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const body = parseBody(refreshSchema, req);
  const result = await service.refresh(body.refreshToken, metadataOf(req));

  res.json({
    message: 'Session refreshed',
    token: result.token,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    user: result.user,
  });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  await service.logout(user.sessionId, user.id);
  res.json({ message: 'Signed out' });
});

export const profile = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const profileView = await service.getProfile(user.id);
  res.json({ message: 'Profile accessed', user: profileView });
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const body = parseBody(updateProfileSchema, req);
  const updated = await service.updateProfile(user.id, body);
  res.json({ message: 'Profile updated', user: updated });
});

export const mailAuth = asyncHandler(async (req: Request, res: Response) => {
  const body = parseBody(mailAuthSchema, req);
  const user = await service.authenticateForMail(body);
  res.json({ message: 'Mail credentials validated', user });
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const body = parseBody(forgotPasswordSchema, req);
  const result = await service.forgotPassword(body.email);
  res.json(result);
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const body = parseBody(resetPasswordSchema, req);
  const result = await service.resetPassword(body.token, body.password);
  res.json(result);
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const body = parseBody(changePasswordSchema, req);
  const result = await service.changePassword(user.id, body.currentPassword, body.newPassword);
  res.json(result);
});
