import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../platform/configuration/env.js';
import { AppError } from '../../platform/errors/app-error.js';
import { rootLogger } from '../observability/logger.js';
import type { ObjectStorage, PutObjectInput, StoredObject } from './object-storage.js';

function createClient(endpoint: string): S3Client {
  return new S3Client({
    region: env.STORAGE_REGION,
    endpoint,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY,
      secretAccessKey: env.STORAGE_SECRET_KEY,
    },
  });
}

/** Server-side operations use the endpoint reachable from this process. */
const client = createClient(env.STORAGE_ENDPOINT);

/**
 * Presigned URLs are redeemed by the browser, which usually reaches storage on
 * a different host than the API does. The signature covers the Host header, so
 * the URL must be signed with the endpoint the browser will actually call —
 * rewriting the host afterwards would invalidate the signature.
 */
const presignClient = env.STORAGE_PUBLIC_URL ? createClient(env.STORAGE_PUBLIC_URL) : client;

const bucket = env.STORAGE_BUCKET;

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const name = (error as { name?: string })?.name;
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

export class S3ObjectStorage implements ObjectStorage {
  async ensureReady(): Promise<void> {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!isNotFound(error)) {
        throw AppError.storage('Object storage is unreachable', error);
      }
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      rootLogger.info({ bucket }, 'created object storage bucket');
    }
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
    const contentType = input.contentType ?? 'application/octet-stream';

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.key,
          Body: body,
          ContentType: contentType,
          ContentLength: input.contentLength ?? (Buffer.isBuffer(body) ? body.byteLength : undefined),
          Metadata: input.metadata,
        }),
      );
    } catch (error) {
      throw AppError.storage('Failed to store file contents', error);
    }

    return {
      key: input.key,
      size: input.contentLength ?? (Buffer.isBuffer(body) ? body.byteLength : 0),
      contentType,
    };
  }

  async getBuffer(key: string): Promise<Buffer> {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await response.Body?.transformToByteArray();
      return Buffer.from(bytes ?? new Uint8Array());
    } catch (error) {
      if (isNotFound(error)) {
        throw AppError.notFound('Stored object not found');
      }
      throw AppError.storage('Failed to read file contents', error);
    }
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return response.Body as Readable;
    } catch (error) {
      if (isNotFound(error)) {
        throw AppError.notFound('Stored object not found');
      }
      throw AppError.storage('Failed to read file contents', error);
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        key,
        size: response.ContentLength ?? 0,
        contentType: response.ContentType ?? 'application/octet-stream',
        checksum: response.ETag?.replaceAll('"', ''),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw AppError.storage('Failed to stat stored object', error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw AppError.storage('Failed to delete stored object', error);
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    // S3 caps a single delete request at 1000 keys.
    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000);
      try {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      } catch (error) {
        throw AppError.storage('Failed to delete stored objects', error);
      }
    }
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${sourceKey}`,
          Key: destinationKey,
        }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw AppError.notFound('Stored object not found');
      }
      throw AppError.storage('Failed to copy stored object', error);
    }
  }

  async signedDownloadUrl(
    key: string,
    options: { expiresInSeconds?: number; filename?: string } = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(options.filename
        ? { ResponseContentDisposition: `attachment; filename="${sanitiseFilename(options.filename)}"` }
        : {}),
    });
    return getSignedUrl(presignClient, command, { expiresIn: options.expiresInSeconds ?? 900 });
  }

  async signedUploadUrl(
    key: string,
    options: { expiresInSeconds?: number; contentType?: string } = {},
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: options.contentType ?? 'application/octet-stream',
    });
    return getSignedUrl(presignClient, command, { expiresIn: options.expiresInSeconds ?? 900 });
  }
}

function sanitiseFilename(filename: string): string {
  return filename.replace(/["\r\n]/g, '').slice(0, 200);
}

export const objectStorage: ObjectStorage = new S3ObjectStorage();
