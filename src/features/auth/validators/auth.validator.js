import { AppError } from '../../../shared/common/AppError.js';

export function validateRegisterInput({ username, password, firstName, lastName, recoveryEmail, mobile }) {
  if (!username) {
    throw new AppError(400, 'Username is required');
  }

  if (!password || !firstName || !lastName) {
    throw new AppError(400, 'Password, firstName, and lastName are required');
  }

  if (typeof username !== 'string' || typeof password !== 'string' || typeof firstName !== 'string' || typeof lastName !== 'string') {
    throw new AppError(400, 'Username, password, firstName, and lastName must be strings');
  }

  if (recoveryEmail !== undefined && typeof recoveryEmail !== 'string') {
    throw new AppError(400, 'Recovery email must be a string');
  }

  if (mobile !== undefined && typeof mobile !== 'string') {
    throw new AppError(400, 'Recovery phone must be a string');
  }

  if (!recoveryEmail?.trim() && !mobile?.trim()) {
    throw new AppError(400, 'Provide at least one recovery method: email or phone');
  }
}

export function validateLoginInput({ username, password }) {
  if (!username || !password) {
    throw new Error('Username and password are required');
  }

  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new Error('Input fields must be strings');
  }
}

export function validateForgotPasswordInput({ email }) {
  if (!email) {
    throw new Error('Email is required');
  }

  if (typeof email !== 'string') {
    throw new Error('Email must be a string');
  }
}

export function validateResetPasswordInput({ token, password }) {
  if (!token || !password) {
    throw new Error('Token and password are required');
  }

  if (typeof token !== 'string' || typeof password !== 'string') {
    throw new Error('Token and password must be strings');
  }
}
