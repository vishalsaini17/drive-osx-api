import { asyncHandler } from '../../../shared/common/asyncHandler.js';
import { FileService } from '../services/file.service.js';
import { authenticate } from '../../../middleware/auth.middleware.js';

const fileService = new FileService();

export const createFile = asyncHandler(async (req, res) => {
  const { name, type, parentId, content, mimeType } = req.body || {};
  const ownerId = req.user.id;

  if (!name) {
    return res.status(400).json({ message: 'name is required' });
  }

  const file = await fileService.createFile({
    ownerId,
    name,
    type: type || 'file',
    parentId: parentId || null,
    content: content || '',
    mimeType
  });

  res.status(201).json({ message: 'File created', file });
});

export const getFile = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { fileId } = req.params;
  const file = await fileService.getFile(ownerId, fileId);
  res.json({ file });
});

export const listChildren = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { parentId } = req.params;
  const files = await fileService.listChildren(ownerId, parentId || null);
  res.json({ files });
});

export const updateFile = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { fileId } = req.params;
  const updates = req.body || {};
  const file = await fileService.updateFile(ownerId, fileId, updates);
  res.json({ message: 'File updated', file });
});

export const moveFile = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { fileId } = req.params;
  const { parentId } = req.body || {};
  const file = await fileService.moveFile(ownerId, fileId, parentId);
  res.json({ message: 'File moved', file });
});

export const deleteFile = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { fileId } = req.params;
  await fileService.deleteFile(ownerId, fileId);
  res.json({ message: 'File moved to trash' });
});

export const restoreFile = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { fileId } = req.params;
  const file = await fileService.restoreFile(ownerId, fileId);
  res.json({ message: 'File restored', file });
});

export const permanentDeleteFile = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { fileId } = req.params;
  await fileService.permanentDeleteFile(ownerId, fileId);
  res.json({ message: 'File permanently deleted' });
});

export const listDeletedFiles = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const files = await fileService.listDeleted(ownerId);
  res.json({ files });
});

export const searchFiles = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ message: 'query parameter q is required' });
  }
  const files = await fileService.search(ownerId, String(q));
  res.json({ files });
});

export const listStarredFiles = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const files = await fileService.listStarred(ownerId);
  res.json({ files });
});

export const toggleStar = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { fileId } = req.params;
  const file = await fileService.toggleStar(ownerId, fileId);
  res.json({ message: 'Star toggled', file });
});

export const togglePin = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const { fileId } = req.params;
  const file = await fileService.togglePin(ownerId, fileId);
  res.json({ message: 'Pin toggled', file });
});

export const listPinned = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  const files = await fileService.listPinned(ownerId);
  res.json({ files });
});
