import { query, queryMany, queryOne, type Queryable } from '../../infrastructure/database/pool.js';
import type { FileRow, FileType, FileVersionRow } from './files.types.js';

const FILE_COLUMNS = `
  id, organization_id, owner_id, parent_id, name, type, mime_type, size, storage_key,
  checksum, starred, pinned, version_no, metadata, deleted_at, created_at, updated_at
`;

export interface InsertFileInput {
  /** Supplied by the caller so bytes can be written to storage before the row exists. */
  id: string;
  organizationId: string;
  ownerId: string;
  parentId: string | null;
  name: string;
  type: FileType;
  mimeType: string;
  size: number;
  storageKey: string | null;
  checksum?: string | null;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
  contentText?: string | null;
  createdBy: string;
}

export async function insertFile(tx: Queryable, input: InsertFileInput): Promise<FileRow> {
  const { rows } = await tx.query<FileRow>(
    `INSERT INTO files (id, organization_id, owner_id, parent_id, name, type, mime_type, size,
                        storage_key, checksum, pinned, metadata, content_text, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
     RETURNING ${FILE_COLUMNS}`,
    [
      input.id,
      input.organizationId,
      input.ownerId,
      input.parentId,
      input.name,
      input.type,
      input.mimeType,
      input.size,
      input.storageKey,
      input.checksum ?? null,
      input.pinned ?? false,
      JSON.stringify(input.metadata ?? {}),
      input.contentText ?? null,
      input.createdBy,
    ],
  );
  return rows[0]!;
}

export function findFileById(organizationId: string, fileId: string): Promise<FileRow | null> {
  return queryOne<FileRow>(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1 AND organization_id = $2`, [
    fileId,
    organizationId,
  ]);
}

/** Used only by link-share resolution, where the tenant is derived from the file. */
export function findFileByIdUnscoped(fileId: string): Promise<FileRow | null> {
  return queryOne<FileRow>(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1`, [fileId]);
}

export function findFileByNameInFolder(input: {
  organizationId: string;
  ownerId: string;
  parentId: string | null;
  name: string;
}): Promise<FileRow | null> {
  return queryOne<FileRow>(
    `SELECT ${FILE_COLUMNS}
       FROM files
      WHERE organization_id = $1
        AND owner_id = $2
        AND parent_id IS NOT DISTINCT FROM $3
        AND lower(name) = lower($4)
        AND deleted_at IS NULL`,
    [input.organizationId, input.ownerId, input.parentId, input.name],
  );
}

export interface ListChildrenInput {
  organizationId: string;
  ownerId: string;
  parentId: string | null;
  includeDeleted?: boolean;
  limit: number;
  offset: number;
}

export function listChildren(input: ListChildrenInput): Promise<FileRow[]> {
  return queryMany<FileRow>(
    `SELECT ${FILE_COLUMNS}
       FROM files
      WHERE organization_id = $1
        AND owner_id = $2
        AND parent_id IS NOT DISTINCT FROM $3
        AND ($4::boolean OR deleted_at IS NULL)
      ORDER BY type = 'folder' DESC, name
      LIMIT $5 OFFSET $6`,
    [input.organizationId, input.ownerId, input.parentId, input.includeDeleted ?? false, input.limit, input.offset],
  );
}

export async function countChildren(
  organizationId: string,
  parentId: string | null,
  ownerId: string,
): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*) AS count
       FROM files
      WHERE organization_id = $1 AND owner_id = $2 AND parent_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL`,
    [organizationId, ownerId, parentId],
  );
  return Number(row?.count ?? 0);
}

/**
 * Dynamic patch. Only columns listed here can be written, so a client cannot
 * reach fields such as owner_id or organization_id through a JSON body.
 */
const UPDATABLE_COLUMNS: Record<string, string> = {
  name: 'name',
  parentId: 'parent_id',
  mimeType: 'mime_type',
  size: 'size',
  storageKey: 'storage_key',
  checksum: 'checksum',
  starred: 'starred',
  pinned: 'pinned',
  metadata: 'metadata',
  versionNo: 'version_no',
  contentText: 'content_text',
};

export type FilePatch = Partial<{
  name: string;
  parentId: string | null;
  mimeType: string;
  size: number;
  storageKey: string | null;
  checksum: string | null;
  starred: boolean;
  pinned: boolean;
  metadata: Record<string, unknown>;
  versionNo: number;
  contentText: string | null;
}>;

export async function updateFile(
  tx: Queryable,
  fileId: string,
  organizationId: string,
  patch: FilePatch,
  actorId: string,
): Promise<FileRow | null> {
  const assignments: string[] = [];
  const values: unknown[] = [fileId, organizationId, actorId];

  for (const [key, value] of Object.entries(patch)) {
    const column = UPDATABLE_COLUMNS[key];
    if (!column || value === undefined) continue;
    values.push(key === 'metadata' ? JSON.stringify(value) : value);
    assignments.push(`${column} = $${values.length}`);
  }

  if (assignments.length === 0) {
    return findFileById(organizationId, fileId);
  }

  const { rows } = await tx.query<FileRow>(
    `UPDATE files
        SET ${assignments.join(', ')}, updated_by = $3
      WHERE id = $1 AND organization_id = $2
      RETURNING ${FILE_COLUMNS}`,
    values,
  );
  return rows[0] ?? null;
}

export async function softDeleteFile(
  tx: Queryable,
  fileId: string,
  organizationId: string,
  actorId: string,
): Promise<FileRow | null> {
  const { rows } = await tx.query<FileRow>(
    `UPDATE files
        SET deleted_at = now(), deleted_by = $3, starred = false, pinned = false
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
      RETURNING ${FILE_COLUMNS}`,
    [fileId, organizationId, actorId],
  );
  return rows[0] ?? null;
}

export async function restoreFile(
  tx: Queryable,
  fileId: string,
  organizationId: string,
): Promise<FileRow | null> {
  const { rows } = await tx.query<FileRow>(
    `UPDATE files
        SET deleted_at = NULL, deleted_by = NULL
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NOT NULL
      RETURNING ${FILE_COLUMNS}`,
    [fileId, organizationId],
  );
  return rows[0] ?? null;
}

export async function hardDeleteFile(tx: Queryable, fileId: string, organizationId: string): Promise<void> {
  await tx.query('DELETE FROM files WHERE id = $1 AND organization_id = $2', [fileId, organizationId]);
}

export function listTrash(organizationId: string, ownerId: string, limit: number, offset: number): Promise<FileRow[]> {
  return queryMany<FileRow>(
    `SELECT ${FILE_COLUMNS}
       FROM files
      WHERE organization_id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
      LIMIT $3 OFFSET $4`,
    [organizationId, ownerId, limit, offset],
  );
}

export function listStarred(organizationId: string, ownerId: string): Promise<FileRow[]> {
  return queryMany<FileRow>(
    `SELECT ${FILE_COLUMNS}
       FROM files
      WHERE organization_id = $1 AND owner_id = $2 AND starred AND deleted_at IS NULL
      ORDER BY updated_at DESC`,
    [organizationId, ownerId],
  );
}

export function listPinned(organizationId: string, ownerId: string): Promise<FileRow[]> {
  return queryMany<FileRow>(
    `SELECT ${FILE_COLUMNS}
       FROM files
      WHERE organization_id = $1 AND owner_id = $2 AND pinned AND deleted_at IS NULL
      ORDER BY updated_at DESC`,
    [organizationId, ownerId],
  );
}

export function listRecent(organizationId: string, ownerId: string, limit: number): Promise<FileRow[]> {
  return queryMany<FileRow>(
    `SELECT ${FILE_COLUMNS}
       FROM files
      WHERE organization_id = $1 AND owner_id = $2 AND deleted_at IS NULL AND type = 'file'
      ORDER BY updated_at DESC
      LIMIT $3`,
    [organizationId, ownerId, limit],
  );
}

/**
 * Ranked full-text search with a trigram fallback, so partial filenames
 * ("repo" → "quarterly-report.pdf") still match (CLAUDE.md §13).
 */
export function searchFiles(input: {
  organizationId: string;
  ownerId: string;
  term: string;
  limit: number;
  offset: number;
}): Promise<FileRow[]> {
  return queryMany<FileRow>(
    `SELECT ${FILE_COLUMNS.split(',')
      .map((column) => `f.${column.trim()}`)
      .join(', ')}
       FROM files f
      WHERE f.organization_id = $1
        AND f.owner_id = $2
        AND f.deleted_at IS NULL
        AND (f.search_vector @@ websearch_to_tsquery('english', $3) OR f.name ILIKE '%' || $3 || '%')
      ORDER BY ts_rank(f.search_vector, websearch_to_tsquery('english', $3)) DESC,
               similarity(f.name, $3) DESC,
               f.updated_at DESC
      LIMIT $4 OFFSET $5`,
    [input.organizationId, input.ownerId, input.term, input.limit, input.offset],
  );
}

/** All descendants of a folder, deepest first — safe ordering for deletion. */
export function listDescendants(organizationId: string, folderId: string): Promise<FileRow[]> {
  return queryMany<FileRow>(
    `WITH RECURSIVE tree AS (
       SELECT ${FILE_COLUMNS}, 0 AS depth
         FROM files
        WHERE id = $2 AND organization_id = $1
       UNION ALL
       SELECT ${FILE_COLUMNS.split(',')
         .map((column) => `f.${column.trim()}`)
         .join(', ')}, t.depth + 1
         FROM files f
         JOIN tree t ON f.parent_id = t.id
        WHERE f.organization_id = $1
     )
     SELECT ${FILE_COLUMNS} FROM tree WHERE depth > 0 ORDER BY depth DESC`,
    [organizationId, folderId],
  );
}

/** Ancestor chain from root to the file, for breadcrumbs and cycle checks. */
export function listAncestors(organizationId: string, fileId: string): Promise<FileRow[]> {
  return queryMany<FileRow>(
    `WITH RECURSIVE chain AS (
       SELECT ${FILE_COLUMNS}, 0 AS depth
         FROM files
        WHERE id = $2 AND organization_id = $1
       UNION ALL
       SELECT ${FILE_COLUMNS.split(',')
         .map((column) => `f.${column.trim()}`)
         .join(', ')}, c.depth + 1
         FROM files f
         JOIN chain c ON c.parent_id = f.id
        WHERE f.organization_id = $1
     )
     SELECT ${FILE_COLUMNS} FROM chain WHERE depth > 0 ORDER BY depth DESC`,
    [organizationId, fileId],
  );
}

export function listExpiredTrash(olderThanDays: number, limit: number): Promise<FileRow[]> {
  return queryMany<FileRow>(
    `SELECT ${FILE_COLUMNS}
       FROM files
      WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 || ' days')::interval
      ORDER BY deleted_at
      LIMIT $2`,
    [olderThanDays, limit],
  );
}

// --------------------------------------------------------------- versions

export async function insertVersion(
  tx: Queryable,
  input: {
    fileId: string;
    versionNo: number;
    storageKey: string;
    size: number;
    checksum: string | null;
    mimeType: string;
    comment?: string | null;
    createdBy: string;
  },
): Promise<FileVersionRow> {
  const { rows } = await tx.query<FileVersionRow>(
    `INSERT INTO file_versions (file_id, version_no, storage_key, size, checksum, mime_type, comment, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, file_id, version_no, storage_key, size, checksum, mime_type, comment, created_by, created_at`,
    [
      input.fileId,
      input.versionNo,
      input.storageKey,
      input.size,
      input.checksum,
      input.mimeType,
      input.comment ?? null,
      input.createdBy,
    ],
  );
  return rows[0]!;
}

/**
 * The newest version row points at the live object (`originals/…`). When that
 * object is about to be overwritten, its bytes are copied to an immutable
 * `versions/…` key and the row is repointed there, so history never changes
 * underneath a reader.
 */
export async function repointVersionStorage(
  tx: Queryable,
  fileId: string,
  versionNo: number,
  storageKey: string,
): Promise<void> {
  await tx.query('UPDATE file_versions SET storage_key = $3 WHERE file_id = $1 AND version_no = $2', [
    fileId,
    versionNo,
    storageKey,
  ]);
}

export function listVersions(fileId: string): Promise<FileVersionRow[]> {
  return queryMany<FileVersionRow>(
    `SELECT id, file_id, version_no, storage_key, size, checksum, mime_type, comment, created_by, created_at
       FROM file_versions WHERE file_id = $1 ORDER BY version_no DESC`,
    [fileId],
  );
}

export function findVersion(fileId: string, versionId: string): Promise<FileVersionRow | null> {
  return queryOne<FileVersionRow>(
    `SELECT id, file_id, version_no, storage_key, size, checksum, mime_type, comment, created_by, created_at
       FROM file_versions WHERE file_id = $1 AND id = $2`,
    [fileId, versionId],
  );
}

export async function setContentText(fileId: string, contentText: string | null): Promise<void> {
  await query('UPDATE files SET content_text = $2 WHERE id = $1', [fileId, contentText]);
}
