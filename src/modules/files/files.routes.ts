import { Router } from 'express';
import multer from 'multer';
import { env } from '../../platform/configuration/env.js';
import { authenticate } from '../../platform/authentication/authenticate.js';
import { rateLimit } from '../../platform/http/rate-limit.js';
import * as controller from './files.controller.js';

export const fileRoutes = Router();

// Buffered in memory, then streamed to object storage. The limit is enforced
// here as well as in the service so an oversized body is rejected early.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 },
});

fileRoutes.use(authenticate());

// Specific routes are declared before the parameterised ones so that
// "/trash" is never captured as a file id.
fileRoutes.get('/trash', controller.listTrash);
fileRoutes.get('/search', controller.search);
fileRoutes.get('/starred', controller.listStarred);
fileRoutes.get('/pinned', controller.listPinned);
fileRoutes.get('/recent', controller.listRecent);
fileRoutes.get('/children', controller.listChildren);
fileRoutes.get('/children/:parentId', controller.listChildren);

fileRoutes.post('/', controller.create);
fileRoutes.post(
  '/upload',
  rateLimit({ bucket: 'upload', windowSeconds: 60, max: 120 }),
  upload.single('file'),
  controller.upload,
);

fileRoutes.get('/:fileId', controller.get);
fileRoutes.get('/:fileId/breadcrumbs', controller.breadcrumbs);
fileRoutes.get('/:fileId/download', controller.downloadUrl);
fileRoutes.get('/:fileId/content', controller.downloadStream);
fileRoutes.get('/:fileId/versions', controller.listVersions);
fileRoutes.post('/:fileId/versions/:versionId/restore', controller.restoreVersion);

fileRoutes.patch('/:fileId', controller.update);
fileRoutes.patch('/:fileId/move', controller.move);
fileRoutes.patch('/:fileId/star', controller.toggleStar);
fileRoutes.patch('/:fileId/pin', controller.togglePin);
fileRoutes.patch('/:fileId/restore', controller.restore);

fileRoutes.delete('/:fileId', controller.trash);
fileRoutes.delete('/:fileId/permanent', controller.permanentlyDelete);
