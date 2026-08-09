import { AppError } from '../../../shared/common/AppError.js';
import { comparePassword, hashPassword } from '../../../utils/password.js';
import { signToken, generateResetToken, verifyResetToken } from '../../../utils/jwt.js';
import { WorkspaceService } from '../../workspaces/services/workspace.service.js';
import { FileService } from '../../files/services/file.service.js';
import { File } from '../../files/models/file.model.js';
import {
  createUser,
  findUserByEmail,
  findUserByUsername,
  findUserById,
  updateUser,
  findUserByResetToken
} from '../repositories/user.repository.js';

const workspaceService = new WorkspaceService();
const fileService = new FileService();

const DEFAULT_FOLDERS = [
  { name: 'Documents', parentId: null },
  { name: 'Pictures', parentId: null },
  { name: 'Videos', parentId: null },
  { name: 'Music', parentId: null },
];

export class AuthService {
  async register({ username, password, firstName, lastName, recoveryEmail, mobile }) {
    const existingUser = await findUserByUsername(username);
    if (existingUser) {
      throw new AppError(409, 'Username already exists');
    }

    const hashedPassword = await hashPassword(password);
    const fullName = `${firstName.trim()} ${lastName.trim()}`;
    const userEmail = `${username.toLowerCase()}@diveosx.com`;
    const user = await createUser({
      username,
      firstName,
      lastName,
      fullName,
      email: userEmail,
      recoveryEmail: recoveryEmail?.trim() || undefined,
      mobile: mobile?.trim() || undefined,
      password: hashedPassword
    });

    await workspaceService.createWorkspace(user._id, {
      name: `${fullName}'s Workspace`,
      type: 'personal'
    });

    for (const folder of DEFAULT_FOLDERS) {
      const existing = await File.findOne({ ownerId: user._id, name: folder.name, parentId: null, deletedAt: null });
      if (!existing) {
        await fileService.createFile({
          ownerId: user._id,
          name: folder.name,
          type: 'folder',
          parentId: folder.parentId,
          mimeType: 'folder',
          pinned: true
        });
      }
    }

    return {
      user: {
        id: user._id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
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
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
        recoveryEmail: user.recoveryEmail,
        mobile: user.mobile
      }
    };
  }

  async authenticateForMail({ username, password }) {
    const user = await findUserByUsername(username);
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      throw new AppError(401, 'Invalid credentials');
    }

    return {
      id: user._id,
      username: user.username,
      fullName: user.fullName,
      recoveryEmail: user.recoveryEmail,
      mobile: user.mobile,
      email: user.email || null
    };
  }

  async getProfile(userId) {
    const user = await findUserById(userId);
    if (!user) {
      throw new AppError(404, 'User not found');
    }
    return {
      id: user._id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      email: user.email,
      recoveryEmail: user.recoveryEmail,
      mobile: user.mobile
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
