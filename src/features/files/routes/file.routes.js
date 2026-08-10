import express from 'express';
import { authenticate } from '../../../middleware/auth.middleware.js';
import {
  createFile,
  getFile,
  listChildren,
  updateFile,
  moveFile,
  deleteFile,
  restoreFile,
  permanentDeleteFile,
  listDeletedFiles,
  searchFiles,
  listStarredFiles,
  toggleStar,
  togglePin,
  listPinned
} from '../controllers/file.controller.js';

const router = express.Router();

router.post('/', authenticate, createFile);
router.get('/children/:parentId', authenticate, listChildren);
router.get('/trash', authenticate, listDeletedFiles);
router.get('/search', authenticate, searchFiles);
router.get('/starred', authenticate, listStarredFiles);
router.get('/pinned', authenticate, listPinned);
router.get('/:fileId', authenticate, getFile);
router.patch('/:fileId', authenticate, updateFile);
router.patch('/:fileId/move', authenticate, moveFile);
router.delete('/:fileId', authenticate, deleteFile);
router.patch('/:fileId/restore', authenticate, restoreFile);
router.delete('/:fileId/permanent', authenticate, permanentDeleteFile);
router.patch('/:fileId/star', authenticate, toggleStar);
router.patch('/:fileId/pin', authenticate, togglePin);

export default router;
