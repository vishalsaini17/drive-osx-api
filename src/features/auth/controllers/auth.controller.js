import { asyncHandler } from '../../../shared/common/asyncHandler.js';
import { AuthService } from '../services/auth.service.js';
import { RegisterDto } from '../dto/register.dto.js';
import { LoginDto } from '../dto/login.dto.js';
import { ForgotPasswordDto } from '../dto/forgot-password.dto.js';
import { ResetPasswordDto } from '../dto/reset-password.dto.js';
import {
  validateRegisterInput,
  validateLoginInput,
  validateForgotPasswordInput,
  validateResetPasswordInput
} from '../validators/auth.validator.js';

const authService = new AuthService();

export const register = asyncHandler(async (req, res) => {
  const dto = new RegisterDto(req.body);
  validateRegisterInput(dto);

  const result = await authService.register(dto);
  res.status(201).json({ message: 'User registered successfully', ...result });
});

export const login = asyncHandler(async (req, res) => {
  const dto = new LoginDto(req.body);
  validateLoginInput(dto);

  const result = await authService.login(dto);
  res.json({ message: 'Login successful', ...result });
});

export const profile = asyncHandler(async (req, res) => {
  res.json({ message: 'Profile accessed', user: req.user });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const dto = new ForgotPasswordDto(req.body);
  validateForgotPasswordInput(dto);

  const result = await authService.forgotPassword(dto);
  res.json({ message: result.message, resetToken: result.resetToken });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const dto = new ResetPasswordDto(req.body);
  validateResetPasswordInput(dto);

  const result = await authService.resetPassword(dto);
  res.json({ message: result.message });
});
