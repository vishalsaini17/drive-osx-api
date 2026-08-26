import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { env } from '../../platform/configuration/env.js';
import { AppError } from '../../platform/errors/app-error.js';
import { publishEvent } from '../../platform/events/event-bus.js';
import { requireFileAccess } from '../../platform/authorization/access-control.js';
import type { ResourceRole } from '../../platform/authorization/roles.js';
import { withTransaction, type Queryable } from '../../infrastructure/database/pool.js';
import { logger } from '../../infrastructure/observability/logger.js';
import { objectKeys } from '../../infrastructure/storage/object-storage.js';
import { objectStorage } from '../../infrastructure/storage/s3-object-storage.js';
import { enqueue } from '../../infrastructure/queue/queue.js';
import { recordAudit } from '../audit/audit.service.js';
import { addStorageUsage, getStorageUsage } from '../organizations/organizations.repository.js';
import * as repository from './files.repository.js';
import {
  inferMimeType,
  isTextLike,
  toFileView,
  toVersionView,
  type FileRow,
  type FileType,
  type FileVersionView,
  type FileView,
} from './files.types.js';

export interface Actor {
  userId: string;
  organizationId: string;
}

const DEFAULT_FOLDERS = ['Documents', 'Pictures', 'Videos', 'Music'] as const;
const MAX_NAME_LENGTH = 255;

/** Rejects path traversal and control characters before a name reaches storage. */
export function assertValidFileName(name: string): string {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    throw AppError.validation('Name cannot be empty');
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw AppError.validation(`Name cannot be longer than ${MAX_NAME_LENGTH} characters`);
  }
  if (trimmed === '.' || trimmed === '..') {
    throw AppError.validation('"." and ".." are not valid names');
  }
  if (/[/\\]/.test(trimmed)) {
    throw AppError.validation('Name cannot contain path separators');
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw AppError.validation('Name cannot contain control characters');
  }

  return trimmed;
}

/**
 * Creates the starter folders for a new drive. Runs inside the caller's
 * transaction so a new account is never half-provisioned.
 */
export async function provisionDefaultFolders(
  tx: Queryable,
  input: { organizationId: string; ownerId: string },
): Promise<void> {
  for (const name of DEFAULT_FOLDERS) {
    await repository.insertFile(tx, {
      id: randomUUID(),
      organizationId: input.organizationId,
      ownerId: input.ownerId,
      parentId: null,
      name,
      type: 'folder',
      mimeType: 'folder',
      size: 0,
      storageKey: null,
      pinned: true,
      metadata: { system: true },
      createdBy: input.ownerId,
    });
  }
}

/**
 * Default folders (Documents, Pictures, Videos, Music) are provisioned with
 * `metadata.system = true` and are meant to be a fixed set of root-level
 * places — the sidebar and `resolveDefaultFolderId` on the frontend look
 * them up by name at the root. Deleting, renaming or relocating one would
 * silently break those lookups, so the identity-changing operations below
 * refuse to act on them regardless of who owns them.
 */
export function isSystemFolder(file: FileRow): boolean {
  return file.type === 'folder' && file.metadata?.system === true;
}

export function assertNotSystemFolder(file: FileRow, action: string): void {
  if (isSystemFolder(file)) {
    throw AppError.validation(`"${file.name}" is a default folder and cannot be ${action}`);
  }
}

/**
 * Unscoped by organization on purpose: a shared file legitimately belongs to
 * a different organization than the actor's (every user gets their own
 * personal org, and sharing is the path meant to cross that boundary).
 * `requireFileAccess` below is what actually authorizes the request; scoping
 * the lookup itself would reject a valid cross-org share before that check
 * ever runs.
 */
async function loadFileOrFail(fileId: string): Promise<FileRow> {
  const file = await repository.findFileByIdUnscoped(fileId);
  if (!file) {
    throw AppError.notFound('File not found');
  }
  return file;
}

/**
 * A destination folder must exist, be a folder, and the actor must hold at
 * least editor access to it — via ownership, an organization role, or a
 * direct/inherited share (CLAUDE.md §17). Placing something in a folder you
 * only have editor rights to (not ownership of) is intentionally allowed:
 * that's what sharing a folder for collaboration means.
 */
async function assertParentIsUsableFolder(actorUserId: string, parentId: string | null): Promise<void> {
  if (!parentId) return;

  const parent = await repository.findFileByIdUnscoped(parentId);
  if (!parent || parent.deleted_at) {
    throw AppError.notFound('Destination folder not found');
  }
  if (parent.type !== 'folder') {
    throw AppError.validation('Destination must be a folder');
  }
  await requireFileAccess(actorUserId, subjectOf(parent), 'editor');
}

async function assertNameAvailable(input: {
  /** Null when `parentId` is a real folder — see `files.repository.ts`. */
  organizationId: string | null;
  ownerId: string | null;
  parentId: string | null;
  name: string;
  exceptFileId?: string;
}): Promise<void> {
  const existing = await repository.findFileByNameInFolder(input);
  if (existing && existing.id !== input.exceptFileId) {
    throw AppError.conflict(`"${input.name}" already exists in this folder`, {
      conflictingFileId: existing.id,
      suggestion: suggestAlternativeName(input.name),
    });
  }
}

/** "report.pdf" → "report (1).pdf" — offered to the client on a name conflict. */
export function suggestAlternativeName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (1)`;
  return `${name.slice(0, dot)} (1)${name.slice(dot)}`;
}

async function assertWithinQuota(organizationId: string, additionalBytes: number): Promise<void> {
  if (additionalBytes <= 0) return;

  const usage = await getStorageUsage(organizationId);
  if (!usage) return;

  const used = Number(usage.used);
  const quota = Number(usage.quota);

  if (used + additionalBytes > quota) {
    throw AppError.quota('Not enough storage space in this workspace', {
      usedBytes: used,
      quotaBytes: quota,
      requiredBytes: additionalBytes,
    });
  }
}

function checksumOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function readInlineContent(file: FileRow): Promise<string | undefined> {
  if (file.type === 'folder' || !file.storage_key) return '';
  // A file created/uploaded before its extension was recognized (or before it
  // was added to EXTENSION_MIME_TYPES) can be stuck at the generic fallback
  // mimeType in the database even though updateFile() self-heals it on the
  // next save. Re-check against the filename here too, so content isn't
  // withheld on read just because no save has happened since.
  const effectiveMimeType = isTextLike(file.mime_type) ? file.mime_type : inferMimeType(file.name, file.type);
  if (!isTextLike(effectiveMimeType)) return undefined;
  if (Number(file.size) > env.INLINE_CONTENT_MAX_BYTES) return undefined;

  try {
    const buffer = await objectStorage.getBuffer(file.storage_key);
    return buffer.toString('utf8');
  } catch (error) {
    // A missing object must not make the whole listing fail; the metadata is
    // still valid and the client shows the file without content.
    logger().error({ err: error, fileId: file.id }, 'failed to read inline file content');
    return undefined;
  }
}

export interface CreateFileInput {
  actor: Actor;
  name: string;
  type?: FileType;
  parentId?: string | null;
  content?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export async function createFile(input: CreateFileInput): Promise<FileView> {
  const { actor } = input;
  const name = assertValidFileName(input.name);
  const type: FileType = input.type ?? 'file';
  const parentId = input.parentId ?? null;
  const mimeType = input.mimeType || inferMimeType(name, type);

  await assertParentIsUsableFolder(actor.userId, parentId);
  await assertNameAvailable({
    organizationId: parentId ? null : actor.organizationId,
    ownerId: parentId ? null : actor.userId,
    parentId,
    name,
  });

  const fileId = randomUUID();
  const body = Buffer.from(input.content ?? '', 'utf8');
  const size = type === 'folder' ? 0 : body.byteLength;

  await assertWithinQuota(actor.organizationId, size);

  const storageKey = type === 'folder' ? null : objectKeys.original(actor.organizationId, fileId);

  // Bytes first: a failed write leaves no metadata pointing at a missing object.
  if (storageKey) {
    await objectStorage.put({ key: storageKey, body, contentType: mimeType, contentLength: size });
  }

  try {
    const row = await withTransaction(async (tx) => {
      const created = await repository.insertFile(tx, {
        id: fileId,
        organizationId: actor.organizationId,
        ownerId: actor.userId,
        parentId,
        name,
        type,
        mimeType,
        size,
        storageKey,
        checksum: type === 'folder' ? null : checksumOf(body),
        metadata: input.metadata ?? {},
        contentText: type !== 'folder' && isTextLike(mimeType) ? body.toString('utf8').slice(0, 100_000) : null,
        createdBy: actor.userId,
      });

      if (storageKey) {
        await repository.insertVersion(tx, {
          fileId,
          versionNo: 1,
          storageKey,
          size,
          checksum: checksumOf(body),
          mimeType,
          comment: 'Initial version',
          createdBy: actor.userId,
        });
        await addStorageUsage(tx, actor.organizationId, size);
      }

      await recordAudit(tx, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: type === 'folder' ? 'folder.created' : 'file.created',
        resourceType: 'file',
        resourceId: fileId,
        metadata: { name, parentId, size },
      });

      await publishEvent(
        tx,
        'file.uploaded',
        {
          organizationId: actor.organizationId,
          fileId,
          ownerId: actor.userId,
          mimeType,
          size,
        },
        { organizationId: actor.organizationId, actorId: actor.userId },
      );

      return created;
    });

    return toFileView(row, { content: input.content ?? '' });
  } catch (error) {
    // Compensate: the object would otherwise be orphaned in storage.
    if (storageKey) {
      await objectStorage.delete(storageKey).catch(() => undefined);
    }
    throw error;
  }
}

/** "report.pdf" → "report - Copy.pdf" → "report - Copy (2).pdf" — the naming a desktop OS uses for "Make a copy". */
function suggestCopyName(name: string, attempt: number): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return attempt === 1 ? `${base} - Copy${ext}` : `${base} - Copy (${attempt})${ext}`;
}

async function findAvailableCopyName(
  organizationId: string | null,
  ownerId: string | null,
  parentId: string | null,
  sourceName: string,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = suggestCopyName(sourceName, attempt);
    const existing = await repository.findFileByNameInFolder({ organizationId, ownerId, parentId, name: candidate });
    if (!existing) return candidate;
  }
}

const MAX_DUPLICATE_ENTRIES = 2000;

/**
 * Makes a real, independent copy — a new database row plus (for a file) a
 * server-side copy of the stored object via `objectStorage.copy`, not a
 * client-side stub with a fabricated id. Anything duplicated this way is a
 * fully real file/folder the instant it's created, so renaming, deleting,
 * moving, sharing, and downloading it all work exactly like they would for
 * anything else — because it *is* anything else, not a local-only shadow
 * that the next backend-driven refresh would quietly discard.
 */
export async function duplicateFile(actor: Actor, fileId: string, targetParentId?: string | null): Promise<FileView> {
  const source = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(source), 'viewer');

  const parentId = targetParentId !== undefined ? targetParentId : source.parent_id;
  await assertParentIsUsableFolder(actor.userId, parentId);

  const scopeOwnerId = parentId ? null : actor.userId;
  const scopeOrganizationId = parentId ? null : actor.organizationId;
  const newName = await findAvailableCopyName(scopeOrganizationId, scopeOwnerId, parentId, source.name);

  if (source.type === 'file') {
    return duplicateSingleFile(actor, source, parentId, newName);
  }
  return duplicateFolderTree(actor, source, parentId, newName);
}

async function duplicateSingleFile(
  actor: Actor,
  source: FileRow,
  parentId: string | null,
  newName: string,
): Promise<FileView> {
  const size = Number(source.size);
  await assertWithinQuota(actor.organizationId, size);

  const newId = randomUUID();
  let newStorageKey: string | null = null;
  if (source.storage_key) {
    newStorageKey = objectKeys.original(actor.organizationId, newId);
    await objectStorage.copy(source.storage_key, newStorageKey);
  }

  const content = await readInlineContent(source);

  try {
    const row = await withTransaction(async (tx) => {
      const created = await repository.insertFile(tx, {
        id: newId,
        organizationId: actor.organizationId,
        ownerId: actor.userId,
        parentId,
        name: newName,
        type: 'file',
        mimeType: source.mime_type,
        size,
        storageKey: newStorageKey,
        checksum: source.checksum,
        metadata: source.metadata ?? {},
        contentText: content && isTextLike(source.mime_type) ? content.slice(0, 100_000) : null,
        createdBy: actor.userId,
      });

      if (newStorageKey) {
        await repository.insertVersion(tx, {
          fileId: newId,
          versionNo: 1,
          storageKey: newStorageKey,
          size,
          checksum: source.checksum,
          mimeType: source.mime_type,
          comment: `Copy of "${source.name}"`,
          createdBy: actor.userId,
        });
        await addStorageUsage(tx, actor.organizationId, size);
      }

      await recordAudit(tx, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: 'file.duplicated',
        resourceType: 'file',
        resourceId: newId,
        metadata: { sourceFileId: source.id, name: newName, parentId },
      });

      await publishEvent(
        tx,
        'file.uploaded',
        { organizationId: actor.organizationId, fileId: newId, ownerId: actor.userId, mimeType: source.mime_type, size },
        { organizationId: actor.organizationId, actorId: actor.userId },
      );

      return created;
    });

    return toFileView(row, { content: content ?? undefined });
  } catch (error) {
    if (newStorageKey) await objectStorage.delete(newStorageKey).catch(() => undefined);
    throw error;
  }
}

async function duplicateFolderTree(
  actor: Actor,
  source: FileRow,
  parentId: string | null,
  newName: string,
): Promise<FileView> {
  const descendants = (await repository.listDescendants(source.id)).slice().reverse(); // shallowest first
  if (descendants.length > MAX_DUPLICATE_ENTRIES) {
    throw AppError.validation(`Folder is too large to duplicate (limit is ${MAX_DUPLICATE_ENTRIES} items)`);
  }

  const totalBytes = descendants.reduce((sum, row) => sum + (row.type === 'file' ? Number(row.size) : 0), 0);
  await assertWithinQuota(actor.organizationId, totalBytes);

  // A duplicate of a default folder (Documents, Pictures, …) is an ordinary
  // folder, not another fixed root location — copying `metadata.system`
  // along with it would produce a folder the user could never rename,
  // move or delete.
  const { system: _sourceIsSystem, ...duplicatedMetadata } = source.metadata ?? {};

  const newFolderId = randomUUID();
  const newFolderRow = await withTransaction((tx) =>
    repository.insertFile(tx, {
      id: newFolderId,
      organizationId: actor.organizationId,
      ownerId: actor.userId,
      parentId,
      name: newName,
      type: 'folder',
      mimeType: 'folder',
      size: 0,
      storageKey: null,
      metadata: duplicatedMetadata,
      createdBy: actor.userId,
    }),
  );

  const idMap = new Map<string, string>([[source.id, newFolderId]]);

  for (const row of descendants) {
    const newId = randomUUID();
    const mappedParentId = (row.parent_id && idMap.get(row.parent_id)) || newFolderId;
    idMap.set(row.id, newId);

    if (row.type === 'folder') {
      await withTransaction((tx) =>
        repository.insertFile(tx, {
          id: newId,
          organizationId: actor.organizationId,
          ownerId: actor.userId,
          parentId: mappedParentId,
          name: row.name,
          type: 'folder',
          mimeType: 'folder',
          size: 0,
          storageKey: null,
          metadata: row.metadata ?? {},
          createdBy: actor.userId,
        }),
      );
      continue;
    }

    const size = Number(row.size);
    let newStorageKey: string | null = null;
    if (row.storage_key) {
      newStorageKey = objectKeys.original(actor.organizationId, newId);
      await objectStorage.copy(row.storage_key, newStorageKey);
    }

    await withTransaction(async (tx) => {
      await repository.insertFile(tx, {
        id: newId,
        organizationId: actor.organizationId,
        ownerId: actor.userId,
        parentId: mappedParentId,
        name: row.name,
        type: 'file',
        mimeType: row.mime_type,
        size,
        storageKey: newStorageKey,
        checksum: row.checksum,
        metadata: row.metadata ?? {},
        createdBy: actor.userId,
      });

      if (newStorageKey) {
        await repository.insertVersion(tx, {
          fileId: newId,
          versionNo: 1,
          storageKey: newStorageKey,
          size,
          checksum: row.checksum,
          mimeType: row.mime_type,
          comment: 'Initial version',
          createdBy: actor.userId,
        });
        await addStorageUsage(tx, actor.organizationId, size);
      }
    });
  }

  await withTransaction((tx) =>
    recordAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'folder.duplicated',
      resourceType: 'file',
      resourceId: newFolderId,
      metadata: { sourceFileId: source.id, name: newName, parentId, itemCount: descendants.length },
    }),
  );

  return toFileView(newFolderRow);
}

export interface GetFileOptions {
  includeContent?: boolean;
  includeVersions?: boolean;
}

export async function getFile(actor: Actor, fileId: string, options: GetFileOptions = {}): Promise<FileView> {
  const file = await loadFileOrFail(fileId);
  const role = await requireFileAccess(actor.userId, subjectOf(file), 'viewer');

  const extras: { content?: string; versions?: FileVersionView[]; effectiveRole?: ResourceRole } = {
    effectiveRole: role,
  };

  if (options.includeContent !== false) {
    const content = await readInlineContent(file);
    if (content !== undefined) extras.content = content;
  }

  if (options.includeVersions) {
    extras.versions = (await repository.listVersions(fileId)).map(toVersionView);
  }

  return toFileView(file, extras);
}

export interface ListChildrenOptions {
  parentId: string | null;
  limit?: number;
  offset?: number;
  includeContent?: boolean;
}

export async function listChildren(actor: Actor, options: ListChildrenOptions): Promise<FileView[]> {
  // A viewer's role on the folder governs its contents uniformly; resolving
  // it per-child would mean one authorization query per row.
  let role: ResourceRole = 'owner';
  if (options.parentId) {
    const parent = await loadFileOrFail(options.parentId);
    role = await requireFileAccess(actor.userId, subjectOf(parent), 'viewer');
  }

  const rows = await repository.listChildren({
    organizationId: options.parentId ? null : actor.organizationId,
    ownerId: options.parentId ? null : actor.userId,
    parentId: options.parentId,
    limit: options.limit ?? 500,
    offset: options.offset ?? 0,
  });

  return decorate(rows, options.includeContent === true, role);
}

export interface UpdateFileInput {
  name?: string;
  content?: string;
  starred?: boolean;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
  mimeType?: string;
}

/**
 * Content updates archive the previous bytes as a version before overwriting,
 * so user content is never lost (CLAUDE.md §40).
 */
export async function updateFile(actor: Actor, fileId: string, input: UpdateFileInput): Promise<FileView> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'editor');

  const patch: repository.FilePatch = {};
  let newName: string | undefined;

  if (input.name !== undefined && input.name !== file.name) {
    assertNotSystemFolder(file, 'renamed');
    newName = assertValidFileName(input.name);
    await assertNameAvailable({
      organizationId: file.parent_id ? null : file.organization_id,
      ownerId: file.parent_id ? null : file.owner_id,
      parentId: file.parent_id,
      name: newName,
      exceptFileId: fileId,
    });
    patch.name = newName;
  }

  if (input.starred !== undefined) patch.starred = input.starred;
  if (input.pinned !== undefined) patch.pinned = input.pinned;
  if (input.metadata !== undefined) patch.metadata = { ...(file.metadata ?? {}), ...input.metadata };
  if (input.mimeType !== undefined) patch.mimeType = input.mimeType;

  let archivedVersionKey: string | null = null;
  let newSize = Number(file.size);

  if (input.content !== undefined) {
    if (file.type === 'folder') {
      throw AppError.validation('A folder has no content to update');
    }

    const body = Buffer.from(input.content, 'utf8');
    newSize = body.byteLength;
    await assertWithinQuota(actor.organizationId, newSize - Number(file.size));

    const currentKey = file.storage_key ?? objectKeys.original(actor.organizationId, fileId);

    // Content-editing clients (e.g. the code editor) don't always resend a
    // mimeType on every save. If the file is stuck at the generic fallback —
    // typically from an earlier upload/creation whose extension wasn't
    // recognized — re-infer it from the filename here so a save always
    // self-heals a wrongly tagged file, rather than requiring content to stay
    // permanently withheld on read (readInlineContent()/isTextLike() below).
    const effectiveMimeType =
      input.mimeType ?? (file.mime_type === 'application/octet-stream' ? inferMimeType(file.name, 'file') : file.mime_type);
    if (effectiveMimeType !== file.mime_type) patch.mimeType = effectiveMimeType;

    // Preserve the outgoing bytes before they are overwritten. A failure here
    // aborts the edit: losing the previous version silently is worse than
    // asking the user to retry.
    if (file.storage_key) {
      archivedVersionKey = objectKeys.version(actor.organizationId, fileId, randomUUID());
      await objectStorage.copy(file.storage_key, archivedVersionKey);
    }

    await objectStorage.put({
      key: currentKey,
      body,
      contentType: effectiveMimeType,
      contentLength: newSize,
    });

    patch.storageKey = currentKey;
    patch.size = newSize;
    patch.checksum = checksumOf(body);
    patch.versionNo = file.version_no + 1;
    patch.contentText = isTextLike(effectiveMimeType) ? body.toString('utf8').slice(0, 100_000) : null;
  }

  const updated = await withTransaction(async (tx) => {
    const row = await repository.updateFile(tx, fileId, file.organization_id, patch, actor.userId);
    if (!row) throw AppError.notFound('File not found');

    if (input.content !== undefined) {
      // Repoint the outgoing version at its archived copy, then record the new
      // one against the live object.
      if (archivedVersionKey) {
        await repository.repointVersionStorage(tx, fileId, file.version_no, archivedVersionKey);
      }
      await repository.insertVersion(tx, {
        fileId,
        versionNo: file.version_no + 1,
        storageKey: patch.storageKey ?? objectKeys.original(actor.organizationId, fileId),
        size: newSize,
        checksum: patch.checksum ?? null,
        mimeType: patch.mimeType ?? file.mime_type,
        comment: 'Edited',
        createdBy: actor.userId,
      });
      await addStorageUsage(tx, actor.organizationId, newSize - Number(file.size));
      await publishEvent(
        tx,
        'file.version_created',
        {
          organizationId: actor.organizationId,
          fileId,
          versionId: archivedVersionKey ?? '',
          actorId: actor.userId,
        },
        { organizationId: actor.organizationId, actorId: actor.userId },
      );
    }

    if (newName) {
      await publishEvent(
        tx,
        'file.renamed',
        { organizationId: actor.organizationId, fileId, actorId: actor.userId, from: file.name, to: newName },
        { organizationId: actor.organizationId, actorId: actor.userId },
      );
    }

    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'file.updated',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { fields: Object.keys(patch) },
    });

    await publishEvent(
      tx,
      'file.updated',
      { organizationId: actor.organizationId, fileId, actorId: actor.userId },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );

    return row;
  });

  return toFileView(updated, input.content !== undefined ? { content: input.content } : {});
}

export async function moveFile(actor: Actor, fileId: string, targetParentId: string | null): Promise<FileView> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'editor');

  if (targetParentId === fileId) {
    throw AppError.validation('A folder cannot be moved into itself');
  }

  assertNotSystemFolder(file, 'moved');
  await assertParentIsUsableFolder(actor.userId, targetParentId);

  if (file.type === 'folder' && targetParentId) {
    const ancestors = await repository.listAncestors(targetParentId);
    if (ancestors.some((ancestor) => ancestor.id === fileId)) {
      throw AppError.validation('A folder cannot be moved into one of its own subfolders');
    }
  }

  await assertNameAvailable({
    organizationId: targetParentId ? null : file.organization_id,
    ownerId: targetParentId ? null : file.owner_id,
    parentId: targetParentId,
    name: file.name,
    exceptFileId: fileId,
  });

  const row = await withTransaction(async (tx) => {
    const updated = await repository.updateFile(
      tx,
      fileId,
      file.organization_id,
      { parentId: targetParentId },
      actor.userId,
    );
    if (!updated) throw AppError.notFound('File not found');

    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'file.moved',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { from: file.parent_id, to: targetParentId },
    });

    await publishEvent(
      tx,
      'file.moved',
      { organizationId: actor.organizationId, fileId, actorId: actor.userId, toParentId: targetParentId },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );

    return updated;
  });

  return toFileView(row);
}

/** Soft delete. Contents stay in storage until the trash is emptied or expires. */
export async function trashFile(actor: Actor, fileId: string): Promise<void> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'editor');

  if (file.deleted_at) return; // Idempotent: already in the trash.

  assertNotSystemFolder(file, 'deleted');

  if (file.type === 'folder') {
    const remaining = await repository.countChildren(null, fileId, null);
    if (remaining > 0) {
      throw AppError.conflict('This folder still contains items', { itemCount: remaining });
    }
  }

  await withTransaction(async (tx) => {
    await repository.softDeleteFile(tx, fileId, file.organization_id, actor.userId);
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'file.trashed',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { name: file.name },
    });
    await publishEvent(
      tx,
      'file.trashed',
      { organizationId: actor.organizationId, fileId, actorId: actor.userId },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );
  });
}

export async function restoreFile(actor: Actor, fileId: string): Promise<FileView> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'editor');

  if (!file.deleted_at) {
    throw AppError.validation('This item is not in the trash');
  }

  // The original folder may itself have been deleted in the meantime.
  if (file.parent_id) {
    const parent = await repository.findFileByIdUnscoped(file.parent_id);
    if (!parent || parent.deleted_at) {
      throw AppError.conflict('The original folder no longer exists. Restore it first or move this item.', {
        parentId: file.parent_id,
      });
    }
  }

  await assertNameAvailable({
    organizationId: file.parent_id ? null : file.organization_id,
    ownerId: file.parent_id ? null : file.owner_id,
    parentId: file.parent_id,
    name: file.name,
    exceptFileId: fileId,
  });

  const row = await withTransaction(async (tx) => {
    const restored = await repository.restoreFile(tx, fileId, file.organization_id);
    if (!restored) throw AppError.notFound('File not found');

    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'file.restored',
      resourceType: 'file',
      resourceId: fileId,
    });
    await publishEvent(
      tx,
      'file.restored',
      { organizationId: actor.organizationId, fileId, actorId: actor.userId },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );

    return restored;
  });

  return toFileView(row);
}

/** Permanent delete: metadata now, stored objects via a background job. */
export async function permanentlyDeleteFile(actor: Actor, fileId: string): Promise<void> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'owner');

  assertNotSystemFolder(file, 'deleted');

  const descendants = file.type === 'folder' ? await repository.listDescendants(fileId) : [];
  const doomed = [...descendants, file];
  const storageKeys = doomed.map((row) => row.storage_key).filter((key): key is string => Boolean(key));
  const reclaimedBytes = doomed.reduce((total, row) => total + Number(row.size), 0);

  await withTransaction(async (tx) => {
    for (const row of doomed) {
      await repository.hardDeleteFile(tx, row.id, row.organization_id);
    }
    await addStorageUsage(tx, actor.organizationId, -reclaimedBytes);
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'file.deleted',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { name: file.name, removedItems: doomed.length, reclaimedBytes },
    });
    await publishEvent(
      tx,
      'file.deleted',
      { organizationId: actor.organizationId, fileId, actorId: actor.userId, storageKeys },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );
  });
}

export async function listTrash(actor: Actor, limit = 200, offset = 0): Promise<FileView[]> {
  const rows = await repository.listTrash(actor.organizationId, actor.userId, limit, offset);
  return rows.map((row) => toFileView(row));
}

export async function listStarred(actor: Actor): Promise<FileView[]> {
  const rows = await repository.listStarred(actor.organizationId, actor.userId);
  return rows.map((row) => toFileView(row));
}

export async function listPinned(actor: Actor): Promise<FileView[]> {
  const rows = await repository.listPinned(actor.organizationId, actor.userId);
  return rows.map((row) => toFileView(row));
}

export async function listRecent(actor: Actor, limit = 20): Promise<FileView[]> {
  const rows = await repository.listRecent(actor.organizationId, actor.userId, limit);
  return rows.map((row) => toFileView(row));
}

export async function searchFiles(actor: Actor, term: string, limit = 50, offset = 0): Promise<FileView[]> {
  const trimmed = term.trim();
  if (trimmed.length === 0) {
    throw AppError.validation('Search term cannot be empty');
  }

  const rows = await repository.searchFiles({
    organizationId: actor.organizationId,
    ownerId: actor.userId,
    term: trimmed,
    limit,
    offset,
  });

  return rows.map((row) => toFileView(row));
}

export async function toggleStar(actor: Actor, fileId: string): Promise<FileView> {
  const file = await loadFileOrFail(fileId);
  return updateFile(actor, fileId, { starred: !file.starred });
}

export async function togglePin(actor: Actor, fileId: string): Promise<FileView> {
  const file = await loadFileOrFail(fileId);
  return updateFile(actor, fileId, { pinned: !file.pinned });
}

export async function listBreadcrumbs(actor: Actor, fileId: string): Promise<Array<{ id: string; name: string }>> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'viewer');

  const ancestors = await repository.listAncestors(fileId);
  return ancestors.map((row) => ({ id: row.id, name: row.name }));
}

// ------------------------------------------------------------------ binary

export interface UploadInput {
  actor: Actor;
  parentId: string | null;
  filename: string;
  buffer: Buffer;
  mimeType?: string;
  /** Idempotency key so a retried upload resolves to the same file. */
  clientToken?: string;
}

export async function uploadFile(input: UploadInput): Promise<FileView> {
  const { actor } = input;
  const name = assertValidFileName(input.filename);
  const mimeType = input.mimeType || inferMimeType(name, 'file');

  if (input.buffer.byteLength > env.MAX_UPLOAD_BYTES) {
    throw AppError.quota('File exceeds the maximum upload size', {
      maxBytes: env.MAX_UPLOAD_BYTES,
      actualBytes: input.buffer.byteLength,
    });
  }

  await assertParentIsUsableFolder(actor.userId, input.parentId);
  await assertWithinQuota(actor.organizationId, input.buffer.byteLength);

  const existing = await repository.findFileByNameInFolder({
    organizationId: input.parentId ? null : actor.organizationId,
    ownerId: input.parentId ? null : actor.userId,
    parentId: input.parentId,
    name,
  });

  // Re-uploading over an existing name creates a new version rather than failing.
  if (existing) {
    return replaceFileContents(actor, existing, input.buffer, mimeType);
  }

  const fileId = randomUUID();
  const storageKey = objectKeys.original(actor.organizationId, fileId);
  const checksum = checksumOf(input.buffer);

  await objectStorage.put({
    key: storageKey,
    body: input.buffer,
    contentType: mimeType,
    contentLength: input.buffer.byteLength,
  });

  try {
    const row = await withTransaction(async (tx) => {
      const created = await repository.insertFile(tx, {
        id: fileId,
        organizationId: actor.organizationId,
        ownerId: actor.userId,
        parentId: input.parentId,
        name,
        type: 'file',
        mimeType,
        size: input.buffer.byteLength,
        storageKey,
        checksum,
        contentText: isTextLike(mimeType) ? input.buffer.toString('utf8').slice(0, 100_000) : null,
        createdBy: actor.userId,
      });

      await repository.insertVersion(tx, {
        fileId,
        versionNo: 1,
        storageKey,
        size: input.buffer.byteLength,
        checksum,
        mimeType,
        comment: 'Uploaded',
        createdBy: actor.userId,
      });

      await addStorageUsage(tx, actor.organizationId, input.buffer.byteLength);

      await recordAudit(tx, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: 'file.uploaded',
        resourceType: 'file',
        resourceId: fileId,
        metadata: { name, size: input.buffer.byteLength, mimeType },
      });

      await publishEvent(
        tx,
        'file.uploaded',
        {
          organizationId: actor.organizationId,
          fileId,
          ownerId: actor.userId,
          mimeType,
          size: input.buffer.byteLength,
        },
        { organizationId: actor.organizationId, actorId: actor.userId },
      );

      return created;
    });

    return toFileView(row);
  } catch (error) {
    await objectStorage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}

async function replaceFileContents(
  actor: Actor,
  file: FileRow,
  buffer: Buffer,
  mimeType: string,
): Promise<FileView> {
  await requireFileAccess(actor.userId, subjectOf(file), 'editor');
  await assertWithinQuota(actor.organizationId, buffer.byteLength - Number(file.size));

  const currentKey = file.storage_key ?? objectKeys.original(actor.organizationId, file.id);
  let archivedKey: string | null = null;

  if (file.storage_key) {
    archivedKey = objectKeys.version(actor.organizationId, file.id, randomUUID());
    await objectStorage.copy(file.storage_key, archivedKey);
  }

  await objectStorage.put({
    key: currentKey,
    body: buffer,
    contentType: mimeType,
    contentLength: buffer.byteLength,
  });

  const row = await withTransaction(async (tx) => {
    const updated = await repository.updateFile(
      tx,
      file.id,
      actor.organizationId,
      {
        size: buffer.byteLength,
        mimeType,
        storageKey: currentKey,
        checksum: checksumOf(buffer),
        versionNo: file.version_no + 1,
        contentText: isTextLike(mimeType) ? buffer.toString('utf8').slice(0, 100_000) : null,
      },
      actor.userId,
    );
    if (!updated) throw AppError.notFound('File not found');

    if (archivedKey) {
      await repository.repointVersionStorage(tx, file.id, file.version_no, archivedKey);
    }

    await repository.insertVersion(tx, {
      fileId: file.id,
      versionNo: file.version_no + 1,
      storageKey: currentKey,
      size: buffer.byteLength,
      checksum: checksumOf(buffer),
      mimeType,
      comment: 'Replaced by a new upload',
      createdBy: actor.userId,
    });

    await addStorageUsage(tx, actor.organizationId, buffer.byteLength - Number(file.size));
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'file.version_created',
      resourceType: 'file',
      resourceId: file.id,
      metadata: { versionNo: file.version_no + 1, size: buffer.byteLength },
    });
    await publishEvent(
      tx,
      'file.version_created',
      {
        organizationId: actor.organizationId,
        fileId: file.id,
        versionId: archivedKey ?? '',
        actorId: actor.userId,
      },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );

    return updated;
  });

  return toFileView(row);
}

// ------------------------------------------------------------ chat mirroring

/**
 * Looks a folder up by name under `parentId` and returns its id, creating it
 * (as a system folder, same convention as `provisionDefaultFolders`) the
 * first time. Callers are expected to retry the lookup on a `conflict` from
 * `createFile` — a concurrent caller can win the same race, which is
 * expected under at-least-once delivery (see `workers/handlers.ts`'s
 * "idempotent" doc comment) rather than a bug.
 */
async function findOrCreateSystemFolder(actor: Actor, parentId: string | null, name: string): Promise<string> {
  const scoped = { organizationId: parentId ? null : actor.organizationId, ownerId: parentId ? null : actor.userId };

  const existing = await repository.findFileByNameInFolder({ ...scoped, parentId, name });
  if (existing && existing.type === 'folder') return existing.id;

  try {
    const created = await createFile({ actor, name, type: 'folder', parentId, metadata: { system: true } });
    return created.id;
  } catch (error) {
    if (error instanceof AppError && error.code === 'conflict') {
      const race = await repository.findFileByNameInFolder({ ...scoped, parentId, name });
      if (race && race.type === 'folder') return race.id;
    }
    throw error;
  }
}

export interface PlaceChatAttachmentInput {
  actor: Actor;
  /** The other party's username for a direct conversation, or the group's title for a group one. */
  peerLabel: string;
  direction: 'Sent' | 'Received';
  filename: string;
  buffer: Buffer;
  mimeType: string;
}

/**
 * Files a chat attachment into `Chat/<peerLabel>/Sent|Received` in the
 * actor's own Drive, creating any of those three folders that don't exist
 * yet. This is how CLAUDE.md §24's domain-event side effects reach into a
 * different module's data: `workers/handlers.ts`'s `chat.message_sent`
 * handler calls this once per participant, the same way it already reuses
 * `purgeStoredObjects` for `file.deleted`.
 *
 * Reuses `uploadFile()` for the actual write, so it gets the same quota
 * accounting, versioning and audit trail as a normal upload — re-filing the
 * same attachment (an at-least-once redelivery) lands as a new version of
 * the same file rather than a duplicate, since `uploadFile` already
 * dedupes by name within a folder.
 */
export async function placeChatAttachment(input: PlaceChatAttachmentInput): Promise<FileView> {
  const peerName = assertValidFileName(input.peerLabel.trim() || 'Unknown');

  const chatFolderId = await findOrCreateSystemFolder(input.actor, null, 'Chat');
  const peerFolderId = await findOrCreateSystemFolder(input.actor, chatFolderId, peerName);
  const directionFolderId = await findOrCreateSystemFolder(input.actor, peerFolderId, input.direction);

  return uploadFile({
    actor: input.actor,
    parentId: directionFolderId,
    filename: input.filename,
    buffer: input.buffer,
    mimeType: input.mimeType,
  });
}

export async function createDownloadUrl(
  actor: Actor,
  fileId: string,
  versionId?: string,
): Promise<{ url: string; filename: string; size: number; mimeType: string; expiresInSeconds: number }> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'viewer');

  if (file.type === 'folder') {
    throw AppError.validation('A folder cannot be downloaded directly');
  }

  let storageKey = file.storage_key;
  let size = Number(file.size);
  let mimeType = file.mime_type;

  if (versionId) {
    const version = await repository.findVersion(fileId, versionId);
    if (!version) throw AppError.notFound('Version not found');
    storageKey = version.storage_key;
    size = Number(version.size);
    mimeType = version.mime_type;
  }

  if (!storageKey) {
    throw AppError.notFound('This file has no stored contents');
  }

  const expiresInSeconds = 900;
  const url = await objectStorage.signedDownloadUrl(storageKey, { expiresInSeconds, filename: file.name });

  return { url, filename: file.name, size, mimeType, expiresInSeconds };
}

export async function streamFile(
  actor: Actor,
  fileId: string,
): Promise<{ stream: NodeJS.ReadableStream; filename: string; mimeType: string; size: number }> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'viewer');

  if (!file.storage_key) {
    throw AppError.notFound('This file has no stored contents');
  }

  const stream = await objectStorage.getStream(file.storage_key);
  return { stream, filename: file.name, mimeType: file.mime_type, size: Number(file.size) };
}

const MAX_ZIP_ENTRIES = 2000;

export interface ZipEntry {
  storageKey: string;
  /** Path inside the archive, e.g. "Notes/Sub Folder/report.pdf". */
  archivePath: string;
  size: number;
}

/**
 * Flattens a selection of files/folders into archive entries. Each top-level
 * item becomes its own root in the zip (a file stays a single entry, a
 * folder becomes a directory of its full subtree) — the same shape a desktop
 * OS produces when you "compress" a multi-selection. Access is checked once
 * per top-level item; everything under an authorized folder is already
 * reachable through it (the same trust boundary `listChildren` relies on).
 */
export async function collectZipEntries(
  actor: Actor,
  fileIds: string[],
): Promise<{ entries: ZipEntry[]; suggestedName: string; totalBytes: number }> {
  if (fileIds.length === 0) {
    throw AppError.validation('Select at least one item to download');
  }

  const usedNames = new Set<string>();
  const entries: ZipEntry[] = [];
  let singleName: string | null = null;

  for (const fileId of fileIds) {
    const file = await loadFileOrFail(fileId);
    await requireFileAccess(actor.userId, subjectOf(file), 'viewer');

    let rootName = file.name;
    while (usedNames.has(rootName)) rootName = `${file.name} (${usedNames.size})`;
    usedNames.add(rootName);
    singleName = fileIds.length === 1 ? file.name : singleName;

    if (file.type === 'file') {
      if (file.storage_key) entries.push({ storageKey: file.storage_key, archivePath: rootName, size: Number(file.size) });
      continue;
    }

    const descendants = await repository.listDescendants(fileId);
    const byId = new Map(descendants.map((row) => [row.id, row]));
    for (const row of descendants) {
      if (row.type !== 'file' || !row.storage_key) continue;

      const segments: string[] = [row.name];
      let parentId = row.parent_id;
      while (parentId && parentId !== fileId) {
        const parent = byId.get(parentId);
        if (!parent) break;
        segments.unshift(parent.name);
        parentId = parent.parent_id;
      }
      segments.unshift(rootName);
      entries.push({ storageKey: row.storage_key, archivePath: segments.join('/'), size: Number(row.size) });

      if (entries.length > MAX_ZIP_ENTRIES) {
        throw AppError.validation(`Selection is too large to zip (limit is ${MAX_ZIP_ENTRIES} files)`);
      }
    }
  }

  if (entries.length === 0) {
    throw AppError.validation('Nothing to download — the selection has no files');
  }

  const suggestedName = fileIds.length === 1 && singleName ? `${singleName}.zip` : 'Download.zip';
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  return { entries, suggestedName, totalBytes };
}

const MAX_ZIP_PART_BYTES = 1024 * 1024 * 1024; // 1 GiB

interface ZipPart {
  entries: ZipEntry[];
  partBytes: number;
}

/**
 * Splits a flat entry list into ≤1GiB chunks so a multi-gigabyte selection
 * downloads as several ordinary-sized zip files instead of one archive the
 * browser has to hold entirely in memory as a single blob. A single entry
 * larger than the cap still gets a part of its own — there's no way to split
 * inside one file.
 */
export function splitIntoZipParts(entries: ZipEntry[], maxPartBytes: number): ZipPart[] {
  const parts: ZipPart[] = [];
  let current: ZipEntry[] = [];
  let currentBytes = 0;

  for (const entry of entries) {
    if (current.length > 0 && currentBytes + entry.size > maxPartBytes) {
      parts.push({ entries: current, partBytes: currentBytes });
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entry.size;
  }
  if (current.length > 0) parts.push({ entries: current, partBytes: currentBytes });
  return parts;
}

/**
 * Resolves one part of a (possibly multi-part) zip download. Stateless and
 * deterministic on purpose: the same `fileIds` always split into the same
 * parts in the same order, so the client can request part 0, learn the total
 * part count from the response, and then request 1..N-1 in turn without the
 * server having to remember anything about the request in between.
 */
export async function getZipPart(
  actor: Actor,
  fileIds: string[],
  partIndex: number,
): Promise<{ entries: ZipEntry[]; filename: string; partIndex: number; totalParts: number; partBytes: number }> {
  const { entries, suggestedName, totalBytes } = await collectZipEntries(actor, fileIds);
  const parts =
    totalBytes > MAX_ZIP_PART_BYTES
      ? splitIntoZipParts(entries, MAX_ZIP_PART_BYTES)
      : [{ entries, partBytes: totalBytes }];

  const part = parts[partIndex];
  if (!part) {
    throw AppError.validation(`Invalid part index ${partIndex} — this download has ${parts.length} part(s)`);
  }

  const baseName = suggestedName.replace(/\.zip$/i, '');
  const filename = parts.length > 1 ? `${baseName} (Part ${partIndex + 1} of ${parts.length}).zip` : suggestedName;

  return {
    entries: part.entries,
    filename,
    partIndex,
    totalParts: parts.length,
    partBytes: part.partBytes,
  };
}

/** Storage-provider detail stays behind the service, even for zip entries. */
export function streamZipEntry(storageKey: string): Promise<Readable> {
  return objectStorage.getStream(storageKey);
}

// ---------------------------------------------------------------- versions

export async function listVersions(actor: Actor, fileId: string): Promise<FileVersionView[]> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'viewer');
  return (await repository.listVersions(fileId)).map(toVersionView);
}

/** Restoring a version copies it forward; history is never rewritten. */
export async function restoreVersion(actor: Actor, fileId: string, versionId: string): Promise<FileView> {
  const file = await loadFileOrFail(fileId);
  await requireFileAccess(actor.userId, subjectOf(file), 'editor');

  const version = await repository.findVersion(fileId, versionId);
  if (!version) throw AppError.notFound('Version not found');

  const buffer = await objectStorage.getBuffer(version.storage_key);
  return replaceFileContents(actor, file, buffer, version.mime_type);
}

// ------------------------------------------------------------------ helpers

function subjectOf(file: FileRow): { fileId: string; organizationId: string; ownerId: string } {
  return { fileId: file.id, organizationId: file.organization_id, ownerId: file.owner_id };
}

async function decorate(rows: FileRow[], includeContent: boolean, effectiveRole: ResourceRole): Promise<FileView[]> {
  if (!includeContent) {
    return rows.map((row) => toFileView(row, { effectiveRole }));
  }

  return Promise.all(
    rows.map(async (row) => {
      const content = await readInlineContent(row);
      return toFileView(row, { effectiveRole, ...(content !== undefined ? { content } : {}) });
    }),
  );
}

/** Called by the purge worker after `file.deleted`. */
export async function purgeStoredObjects(storageKeys: string[]): Promise<void> {
  if (storageKeys.length === 0) return;
  await objectStorage.deleteMany(storageKeys);
  logger().info({ count: storageKeys.length }, 'purged stored objects');
}

export async function scheduleThumbnail(fileId: string, organizationId: string, mimeType: string): Promise<void> {
  if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') return;
  await enqueue('file.thumbnail', { fileId, organizationId });
}
