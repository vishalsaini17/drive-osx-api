import express from 'express';
import { login, profile, register, forgotPassword, resetPassword } from '../controllers/auth.controller.js';
import { authenticate } from '../../../middleware/auth.middleware.js';
import '../docs/auth.swagger.js';

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

router.post('/register', register);
router.post('/login', login);
router.get('/profile', authenticate, profile);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

export default router;
