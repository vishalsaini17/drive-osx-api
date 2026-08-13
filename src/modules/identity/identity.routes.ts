import { Router } from 'express';
import { authenticate } from '../../platform/authentication/authenticate.js';
import { rateLimit } from '../../platform/http/rate-limit.js';
import * as controller from './identity.controller.js';

/**
 * Mounted at the API root so the historical paths (/register, /login,
 * /profile) keep working for existing clients.
 */
export const identityRoutes = Router();

// Credential endpoints get their own, much tighter bucket than general traffic.
const credentialLimit = rateLimit({ bucket: 'auth', windowSeconds: 300, max: 20 });

identityRoutes.post('/register', credentialLimit, controller.register);
identityRoutes.post('/login', credentialLimit, controller.login);
identityRoutes.post('/auth/refresh', rateLimit({ bucket: 'refresh', windowSeconds: 60, max: 30 }), controller.refresh);
identityRoutes.post('/auth/logout', authenticate(), controller.logout);
identityRoutes.post('/auth/change-password', authenticate(), credentialLimit, controller.changePassword);

identityRoutes.get('/profile', authenticate(), controller.profile);
identityRoutes.patch('/profile', authenticate(), controller.updateProfile);

identityRoutes.post('/forgot-password', credentialLimit, controller.forgotPassword);
identityRoutes.post('/reset-password', credentialLimit, controller.resetPassword);

// Called by the SMTP gateway to validate mailbox credentials.
identityRoutes.post('/mail/auth', credentialLimit, controller.mailAuth);
