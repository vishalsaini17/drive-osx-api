import mongoose from 'mongoose';
import { File } from '../models/file.model.js';

export async function createFile(payload) {
  return File.create(payload);
}

export async function findFileById(fileId) {
  return File.findById(fileId);
}

export async function findFilesByParent({ ownerId, parentId, includeDeleted = false }) {
  const filter = { ownerId, parentId: parentId || null };
  if (!includeDeleted) filter.deletedAt = null;
  return File.find(filter).sort({ createdAt: -1 });
}

export async function findFileByNameAndParent({ ownerId, name, parentId }) {
  return File.findOne({ ownerId, name, parentId: parentId || null, deletedAt: null });
}

export async function updateFile(fileId, payload) {
  return File.findByIdAndUpdate(fileId, payload, { new: true });
}

export async function softDeleteFile(fileId) {
  return File.findByIdAndUpdate(fileId, { deletedAt: new Date() }, { new: true });
}

export async function restoreFile(fileId) {
  return File.findByIdAndUpdate(fileId, { deletedAt: null }, { new: true });
}

export async function permanentDeleteFile(fileId) {
  return File.findByIdAndDelete(fileId);
}

export async function findDeletedFiles(ownerId) {
  return File.find({ ownerId, deletedAt: { $ne: null } }).sort({ deletedAt: -1 });
}

export async function searchFiles({ ownerId, query }) {
  return File.find({
    ownerId,
    deletedAt: null,
    $text: { $search: query }
  }).sort({ createdAt: -1 });
}

export async function listStarredFiles(ownerId) {
  return File.find({ ownerId, starred: true, deletedAt: null }).sort({ updatedAt: -1 });
}
