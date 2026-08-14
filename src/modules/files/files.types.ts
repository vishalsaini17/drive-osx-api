export type FileType = 'file' | 'folder';

export interface FileRow {
  id: string;
  organization_id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  type: FileType;
  mime_type: string;
  size: string | number;
  storage_key: string | null;
  checksum: string | null;
  starred: boolean;
  pinned: boolean;
  version_no: number;
  metadata: Record<string, unknown> | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface FileVersionRow {
  id: string;
  file_id: string;
  version_no: number;
  storage_key: string;
  size: string | number;
  checksum: string | null;
  mime_type: string;
  comment: string | null;
  created_by: string | null;
  created_at: Date;
}

export interface FileVersionView {
  id: string;
  versionNo: number;
  size: number;
  mimeType: string;
  comment: string | null;
  createdBy: string | null;
  createdAt: string;
}

/**
 * Public file shape. `_id`, `ownerId`, `parentId` and `versions` are retained
 * from the previous API so existing clients keep working; `id` and the storage
 * fields are the forward-looking names.
 */
export interface FileView {
  id: string;
  _id: string;
  organizationId: string;
  ownerId: string;
  parentId: string | null;
  name: string;
  type: FileType;
  mimeType: string;
  size: number;
  storageKey: string;
  starred: boolean;
  pinned: boolean;
  version: number;
  metadata: Record<string, unknown>;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Inline text content, present only for small text-like files. */
  content?: string;
  versions?: FileVersionView[];
}

export function toFileView(row: FileRow, extras: { content?: string; versions?: FileVersionView[] } = {}): FileView {
  return {
    id: row.id,
    _id: row.id,
    organizationId: row.organization_id,
    ownerId: row.owner_id,
    parentId: row.parent_id,
    name: row.name,
    type: row.type,
    mimeType: row.mime_type,
    size: Number(row.size),
    storageKey: row.storage_key ?? '',
    starred: row.starred,
    pinned: row.pinned,
    version: row.version_no,
    metadata: row.metadata ?? {},
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(extras.content !== undefined ? { content: extras.content } : {}),
    ...(extras.versions !== undefined ? { versions: extras.versions } : {}),
  };
}

export function toVersionView(row: FileVersionRow): FileVersionView {
  return {
    id: row.id,
    versionNo: row.version_no,
    size: Number(row.size),
    mimeType: row.mime_type,
    comment: row.comment,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  js: 'application/javascript',
  ts: 'application/typescript',
  json: 'application/json',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

export function inferMimeType(name: string, type: FileType): string {
  if (type === 'folder') return 'folder';
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  return (extension && EXTENSION_MIME_TYPES[extension]) || 'application/octet-stream';
}

/** Whether content can be round-tripped through the API as a UTF-8 string. */
export function isTextLike(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/xml' ||
    mimeType === 'image/svg+xml' ||
    // RFC 6839 structured syntax suffixes: any vendor/app type built on JSON
    // or XML (e.g. `application/vnd.driveosx.book+json`) is text underneath,
    // so a new structured document format never has to earn its way onto
    // this list one mimetype at a time.
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml')
  );
}
