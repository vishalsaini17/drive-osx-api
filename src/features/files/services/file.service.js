import { AppError } from '../../../shared/common/AppError.js';
import { User } from '../../auth/repositories/user.repository.js';
import { File } from '../models/file.model.js';
import {
  createFile,
  findFileById,
  findFilesByParent,
  findFileByNameAndParent,
  updateFile,
  softDeleteFile,
  restoreFile,
  permanentDeleteFile,
  findDeletedFiles,
  searchFiles,
  listStarredFiles
} from '../repositories/file.repository.js';

export class FileService {
  async createFile({ ownerId, name, type, parentId, content, mimeType, size }) {
    const user = await User.findById(ownerId);
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    if (parentId) {
      const parent = await findFileById(parentId);
      if (!parent || parent.ownerId.toString() !== ownerId.toString()) {
        throw new AppError(404, 'Parent folder not found');
      }
      if (parent.type !== 'folder') {
        throw new AppError(400, 'Parent must be a folder');
      }
    }

    const existing = await findFileByNameAndParent({ ownerId, name, parentId });
    if (existing) {
      throw new AppError(409, 'A file or folder with this name already exists');
    }

    const file = await createFile({
      name,
      type,
      parentId: parentId || null,
      ownerId,
      content: content || '',
      mimeType: mimeType || this.inferMimeType(name, type),
      size: size || 0,
      starred: false,
      deletedAt: null,
      metadata: {},
      versions: []
    });

    return file;
  }

  async getFile(ownerId, fileId) {
    const file = await findFileById(fileId);
    if (!file) {
      throw new AppError(404, 'File not found');
    }
    if (file.ownerId.toString() !== ownerId.toString()) {
      throw new AppError(403, 'Access denied');
    }
    return file;
  }

  async updateFile(ownerId, fileId, updates) {
    const file = await this.getFile(ownerId, fileId);

    if (updates.name && updates.name !== file.name) {
      const existing = await findFileByNameAndParent({
        ownerId,
        name: updates.name,
        parentId: updates.parentId !== undefined ? updates.parentId : file.parentId
      });
      if (existing && existing.id.toString() !== fileId) {
        throw new AppError(409, 'A file or folder with this name already exists');
      }
    }

    const updated = await updateFile(fileId, { ...updates, updatedAt: new Date() });
    return updated;
  }

  async moveFile(ownerId, fileId, targetParentId) {
    const file = await this.getFile(ownerId, fileId);

    if (targetParentId) {
      const targetParent = await findFileById(targetParentId);
      if (!targetParent || targetParent.ownerId.toString() !== ownerId.toString()) {
        throw new AppError(404, 'Target folder not found');
      }
      if (targetParent.type !== 'folder') {
        throw new AppError(400, 'Target must be a folder');
      }
      if (targetParentId.toString() === fileId) {
        throw new AppError(400, 'Cannot move a folder into itself');
      }
    }

    const updated = await updateFile(fileId, { parentId: targetParentId || null });
    return updated;
  }

  async deleteFile(ownerId, fileId) {
    const file = await this.getFile(ownerId, fileId);
    if (file.type === 'folder') {
      const children = await findFilesByParent({ ownerId, parentId: fileId, includeDeleted: true });
      const activeChildren = children.filter(c => c.deletedAt === null);
      if (activeChildren.length > 0) {
        throw new AppError(400, 'Folder is not empty');
      }
    }
    await softDeleteFile(fileId);
  }

  async restoreFile(ownerId, fileId) {
    const file = await findFileById(fileId);
    if (!file || file.ownerId.toString() !== ownerId.toString()) {
      throw new AppError(404, 'File not found');
    }
    if (!file.deletedAt) {
      throw new AppError(400, 'File is not deleted');
    }
    return restoreFile(fileId);
  }

  async permanentDeleteFile(ownerId, fileId) {
    const file = await findFileById(fileId);
    if (!file || file.ownerId.toString() !== ownerId.toString()) {
      throw new AppError(404, 'File not found');
    }
    await permanentDeleteFile(fileId);
  }

  async listChildren(ownerId, parentId, includeDeleted = false) {
    return findFilesByParent({ ownerId, parentId, includeDeleted });
  }

  async listDeleted(ownerId) {
    return findDeletedFiles(ownerId);
  }

  async search(ownerId, query) {
    return searchFiles({ ownerId, query });
  }

  async listStarred(ownerId) {
    return listStarredFiles(ownerId);
  }

  async toggleStar(ownerId, fileId) {
    const file = await this.getFile(ownerId, fileId);
    return updateFile(fileId, { starred: !file.starred });
  }

  async togglePin(ownerId, fileId) {
    const file = await this.getFile(ownerId, fileId);
    return updateFile(fileId, { pinned: !file.pinned });
  }

  async listPinned(ownerId) {
    return File.find({ ownerId, pinned: true, deletedAt: null, type: 'folder' }).sort({ updatedAt: -1 });
  }

  inferMimeType(name, type) {
    if (type === 'folder') return 'folder';
    const ext = name.split('.').pop()?.toLowerCase();
    const map = {
      txt: 'text/plain',
      md: 'text/markdown',
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      ts: 'application/typescript',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      mp4: 'video/mp4',
      zip: 'application/zip',
      tar: 'application/x-tar',
      gz: 'application/gzip'
    };
    return map[ext || ''] || 'application/octet-stream';
  }
}
