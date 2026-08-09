import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../../shared/common/AppError.js';
import {
  validateRegisterInput,
  validateLoginInput,
  validateForgotPasswordInput,
  validateResetPasswordInput
} from '../validators/auth.validator.js';

test('validateRegisterInput accepts a recovery email or phone', () => {
  assert.doesNotThrow(() =>
    validateRegisterInput({
      username: 'john',
      password: 'password123',
      firstName: 'John',
      lastName: 'Doe',
      recoveryEmail: 'john@gmail.com',
      mobile: '+919876543210'
    })
  );
});

test('validateRegisterInput rejects missing username', () => {
  assert.throws(
    () => validateRegisterInput({ password: 'password123', firstName: 'John', lastName: 'Doe', recoveryEmail: 'john@example.com' }),
    (err) => err instanceof AppError && err.statusCode === 400 && /Username is required/.test(err.message)
  );
});

test('validateRegisterInput rejects missing recovery methods', () => {
  assert.throws(
    () => validateRegisterInput({ username: 'john', password: 'password123', firstName: 'John', lastName: 'Doe' }),
    (err) => err instanceof AppError && err.statusCode === 400 && /Provide at least one recovery method/.test(err.message)
  );
});

test('validateLoginInput accepts username as login identity', () => {
  assert.doesNotThrow(() => validateLoginInput({ username: 'john', password: 'password123' }));
});

test('validateLoginInput throws AppError 400 when fields are missing', () => {
  assert.throws(
    () => validateLoginInput({ username: '', password: '' }),
    (err) => err instanceof AppError && err.statusCode === 400 && /Username and password are required/.test(err.message)
  );
});

test('validateForgotPasswordInput throws AppError 400 when email is missing', () => {
  assert.throws(
    () => validateForgotPasswordInput({ email: '' }),
    (err) => err instanceof AppError && err.statusCode === 400 && /Email is required/.test(err.message)
  );
});

test('validateResetPasswordInput throws AppError 400 when token/password missing', () => {
  assert.throws(
    () => validateResetPasswordInput({ token: '', password: '' }),
    (err) => err instanceof AppError && err.statusCode === 400 && /Token and password are required/.test(err.message)
  );
});
