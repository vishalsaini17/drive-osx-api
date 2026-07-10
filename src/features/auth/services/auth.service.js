import { AppError } from '../../../shared/common/AppError.js';
import { comparePassword, hashPassword } from '../../../utils/password.js';
import { signToken, generateResetToken, verifyResetToken } from '../../../utils/jwt.js';
import { WorkspaceService } from '../../workspaces/services/workspace.service.js';
import {
  createUser,
  findUserByEmail,
  findUserByUsername,
  updateUser,
  findUserByResetToken
} from '../repositories/user.repository.js';

const workspaceService = new WorkspaceService();

export class AuthService {
  async register({ username, password, fullName, recoveryEmail, mobile }) {
    const existingUser = await findUserByUsername(username);
    if (existingUser) {
      throw new AppError(409, 'Username already exists');
    }

    const hashedPassword = await hashPassword(password);
    const user = await createUser({
      username,
      fullName,
      recoveryEmail,
      mobile,
      password: hashedPassword
    });

    await workspaceService.createWorkspace(user._id, {
      name: `${fullName}'s Workspace`,
      type: 'personal'
    });

    return {
      user: {
        id: user._id,
        username: user.username,
        fullName: user.fullName,
        recoveryEmail: user.recoveryEmail,
        mobile: user.mobile
      }
    };
  }

  async login({ username, password }) {
    const user = await findUserByUsername(username);
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      throw new AppError(401, 'Invalid credentials');
    }

    const token = signToken({ id: user._id, username: user.username });

    return {
      token,
      user: {
        id: user._id,
        username: user.username,
        fullName: user.fullName,
        recoveryEmail: user.recoveryEmail,
        mobile: user.mobile
      }
    };
  }

  async forgotPassword({ email }) {
    const user = await findUserByEmail(email) || await findUserByUsername(email);
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const resetToken = generateResetToken({ id: user._id, email: user.email });
    const resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await updateUser(user._id, {
      resetToken,
      resetTokenExpiry
    });

    return {
      message: 'Password reset link has been sent to your email',
      resetToken
    };
  }

  async resetPassword({ token, password }) {
    try {
      const decoded = verifyResetToken(token);
      const user = await findUserByResetToken(token);

      if (!user) {
        throw new AppError(400, 'Invalid or expired reset token');
      }

      const hashedPassword = await hashPassword(password);
      await updateUser(user._id, {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null
      });

      return {
        message: 'Password reset successfully'
      };
    } catch (error) {
      throw new AppError(400, 'Invalid or expired reset token');
    }
  }
}
