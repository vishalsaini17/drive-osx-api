import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegisterInput, validateLoginInput } from '../validators/auth.validator.js';

test('validateRegisterInput accepts username, fullName, recoveryEmail and mobile', () => {
  assert.doesNotThrow(() =>
    validateRegisterInput({
      username: 'john',
      password: 'password123',
      fullName: 'John Doe',
      recoveryEmail: 'john@gmail.com',
      mobile: '+919876543210'
    })
  );
});

test('validateRegisterInput rejects missing username', () => {
  assert.throws(
    () => validateRegisterInput({ password: 'password123', fullName: 'John Doe' }),
    /Username is required/
  );
});

test('validateLoginInput accepts username as login identity', () => {
  assert.doesNotThrow(() => validateLoginInput({ username: 'john', password: 'password123' }));
});
