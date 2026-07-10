import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function signToken(payload) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '1h' });
}

export function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

export function generateResetToken(payload) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '15m' });
}

export function verifyResetToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}
