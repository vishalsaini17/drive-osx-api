export function validateRegisterInput({ username, password, fullName, recoveryEmail, mobile }) {
  if (!username) {
    throw new Error('Username is required');
  }

  if (!password || !fullName || !recoveryEmail) {
    throw new Error('Password, fullName, and recoveryEmail are required');
  }

  if (typeof username !== 'string' || typeof password !== 'string' || typeof fullName !== 'string' || typeof recoveryEmail !== 'string') {
    throw new Error('Input fields must be strings');
  }

  if (mobile !== undefined && typeof mobile !== 'string') {
    throw new Error('Mobile must be a string');
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
