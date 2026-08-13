import { Readable } from 'node:stream';

/**
 * Storage abstraction. Application and domain code depends on this interface
 * only — never on S3/R2/GCS specifics (CLAUDE.md §37, §38).
 */
export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
  checksum?: string;
}

export interface PutObjectInput {
  key: string;
  body: Buffer | Readable | string;
  contentType?: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface ObjectStorage {
  put(input: PutObjectInput): Promise<StoredObject>;
  getBuffer(key: string): Promise<Buffer>;
  getStream(key: string): Promise<Readable>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  /** Time-limited direct download URL, so bytes never proxy through the API. */
  signedDownloadUrl(key: string, options?: { expiresInSeconds?: number; filename?: string }): Promise<string>;
  /** Time-limited direct upload URL for large/resumable client uploads. */
  signedUploadUrl(key: string, options?: { expiresInSeconds?: number; contentType?: string }): Promise<string>;
  ensureReady(): Promise<void>;
}

/**
 * Object key layout (CLAUDE.md §11). Keys are tenant-prefixed so a bucket
 * lifecycle rule or a per-tenant export can operate on a single prefix.
 */
export const objectKeys = {
  original: (organizationId: string, fileId: string) => `originals/${organizationId}/${fileId}`,
  version: (organizationId: string, fileId: string, versionId: string) =>
    `versions/${organizationId}/${fileId}/${versionId}`,
  preview: (organizationId: string, fileId: string) => `previews/${organizationId}/${fileId}`,
  thumbnail: (organizationId: string, fileId: string) => `thumbnails/${organizationId}/${fileId}`,
  attachment: (organizationId: string, emailId: string, attachmentId: string) =>
    `attachments/${organizationId}/${emailId}/${attachmentId}`,
  upload: (organizationId: string, uploadId: string) => `uploads/${organizationId}/${uploadId}`,
};
