import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegisterInput, validateLoginInput } from '../validators/auth.validator.js';

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
    /Username is required/
  );
});

test('validateRegisterInput rejects missing recovery methods', () => {
  assert.throws(
    () => validateRegisterInput({ username: 'john', password: 'password123', firstName: 'John', lastName: 'Doe' }),
    /Provide at least one recovery method/
  );
});

test('validateLoginInput accepts username as login identity', () => {
  assert.doesNotThrow(() => validateLoginInput({ username: 'john', password: 'password123' }));
});
