import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireOrganization } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { AppError } from '../../platform/errors/app-error.js';
import { parseBody, parseParams, parseQuery } from '../../platform/http/validate.js';
import * as service from './files.service.js';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  type: z.enum(['file', 'folder']).default('file'),
  parentId: z.string().uuid().nullable().optional(),
  content: z.string().optional(),
  mimeType: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    content: z.string().optional(),
    starred: z.boolean().optional(),
    pinned: z.boolean().optional(),
    mimeType: z.string().max(255).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' });

const moveSchema = z.object({ parentId: z.string().uuid().nullable() });

const fileParams = z.object({ fileId: z.string().uuid('Invalid file id') });
const versionParams = fileParams.extend({ versionId: z.string().uuid('Invalid version id') });

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const searchQuery = pagination.extend({ q: z.string().trim().min(1, 'Enter something to search for') });

const listQuery = pagination.extend({
  includeContent: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

function actorOf(req: Request): service.Actor {
  const { user, organizationId } = requireOrganization(req);
  return { userId: user.id, organizationId };
}

export const create = asyncHandler(async (req: Request, res: Response) => {
  const body = parseBody(createSchema, req);
  const file = await service.createFile({
    actor: actorOf(req),
    name: body.name,
    type: body.type,
    parentId: body.parentId ?? null,
    ...(body.content !== undefined ? { content: body.content } : {}),
    ...(body.mimeType !== undefined ? { mimeType: body.mimeType } : {}),
    ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
  });

  res.status(201).json({ message: `${body.type === 'folder' ? 'Folder' : 'File'} created`, file });
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const file = await service.getFile(actorOf(req), fileId, { includeVersions: req.query.versions === 'true' });
  res.json({ file });
});

export const listChildren = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(listQuery, req);
  // An empty :parentId segment means the drive root.
  const rawParent = req.params.parentId;
  const parentId = rawParent && rawParent !== 'root' ? rawParent : null;

  if (parentId && !z.string().uuid().safeParse(parentId).success) {
    throw AppError.validation('Invalid folder id');
  }

  const files = await service.listChildren(actorOf(req), {
    parentId,
    limit: query.limit,
    offset: query.offset,
    includeContent: query.includeContent,
  });

  res.json({ files, pagination: { limit: query.limit, offset: query.offset, count: files.length } });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const body = parseBody(updateSchema, req);
  const file = await service.updateFile(actorOf(req), fileId, body);
  res.json({ message: 'File updated', file });
});

export const move = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const { parentId } = parseBody(moveSchema, req);
  const file = await service.moveFile(actorOf(req), fileId, parentId);
  res.json({ message: 'File moved', file });
});

export const trash = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  await service.trashFile(actorOf(req), fileId);
  res.json({ message: 'Moved to trash' });
});

export const restore = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const file = await service.restoreFile(actorOf(req), fileId);
  res.json({ message: 'Restored from trash', file });
});

export const permanentlyDelete = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  await service.permanentlyDeleteFile(actorOf(req), fileId);
  res.json({ message: 'Permanently deleted' });
});

export const listTrash = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(pagination, req);
  const files = await service.listTrash(actorOf(req), query.limit, query.offset);
  res.json({ files });
});

export const search = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(searchQuery, req);
  const files = await service.searchFiles(actorOf(req), query.q, query.limit, query.offset);
  res.json({ files, query: query.q });
});

export const listStarred = asyncHandler(async (req: Request, res: Response) => {
  const files = await service.listStarred(actorOf(req));
  res.json({ files });
});

export const listPinned = asyncHandler(async (req: Request, res: Response) => {
  const files = await service.listPinned(actorOf(req));
  res.json({ files });
});

export const listRecent = asyncHandler(async (req: Request, res: Response) => {
  const files = await service.listRecent(actorOf(req));
  res.json({ files });
});

export const toggleStar = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const file = await service.toggleStar(actorOf(req), fileId);
  res.json({ message: 'Star toggled', file });
});

export const togglePin = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const file = await service.togglePin(actorOf(req), fileId);
  res.json({ message: 'Pin toggled', file });
});

export const breadcrumbs = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const path = await service.listBreadcrumbs(actorOf(req), fileId);
  res.json({ path });
});

export const upload = asyncHandler(async (req: Request, res: Response) => {
  const uploaded = req.file;
  if (!uploaded) {
    throw AppError.validation('No file was included in the upload');
  }

  const parentId = typeof req.body?.parentId === 'string' && req.body.parentId ? req.body.parentId : null;

  const file = await service.uploadFile({
    actor: actorOf(req),
    parentId,
    filename: uploaded.originalname,
    buffer: uploaded.buffer,
    mimeType: uploaded.mimetype,
    ...(typeof req.body?.clientToken === 'string' ? { clientToken: req.body.clientToken } : {}),
  });

  res.status(201).json({ message: 'Upload complete', file });
});

/** Returns a short-lived direct URL so bytes do not proxy through the API. */
export const downloadUrl = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
  const download = await service.createDownloadUrl(actorOf(req), fileId, versionId);
  res.json({ download });
});

export const downloadStream = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const result = await service.streamFile(actorOf(req), fileId);

  res.setHeader('Content-Type', result.mimeType);
  res.setHeader('Content-Length', result.size);
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`);

  result.stream.pipe(res);
  result.stream.on('error', (error) => {
    // Headers are already sent; end the response rather than attempting JSON.
    res.destroy(error);
  });
});

export const listVersions = asyncHandler(async (req: Request, res: Response) => {
  const { fileId } = parseParams(fileParams, req);
  const versions = await service.listVersions(actorOf(req), fileId);
  res.json({ versions });
});

export const restoreVersion = asyncHandler(async (req: Request, res: Response) => {
  const { fileId, versionId } = parseParams(versionParams, req);
  const file = await service.restoreVersion(actorOf(req), fileId, versionId);
  res.json({ message: 'Version restored as the current file', file });
});
