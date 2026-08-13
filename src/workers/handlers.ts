import { withTransaction } from '../infrastructure/database/pool.js';
import { logger } from '../infrastructure/observability/logger.js';
import { enqueue, registerJobHandler } from '../infrastructure/queue/queue.js';
import { objectKeys } from '../infrastructure/storage/object-storage.js';
import { objectStorage } from '../infrastructure/storage/s3-object-storage.js';
import { onEvent } from '../platform/events/event-bus.js';
import { findFileByIdUnscoped, setContentText } from '../modules/files/files.repository.js';
import { purgeStoredObjects } from '../modules/files/files.service.js';
import { isTextLike } from '../modules/files/files.types.js';
import { createNotification } from '../modules/notifications/notifications.service.js';
import { findUserById } from '../modules/identity/identity.repository.js';

/**
 * Wiring between domain events and background work (CLAUDE.md §23, §24).
 *
 * Handlers are idempotent: the queue delivers at least once, and an event may
 * be re-dispatched if a sibling handler failed.
 */
export function registerWorkHandlers(): void {
  registerDomainEventHandlers();
  registerQueueHandlers();
}

function registerDomainEventHandlers(): void {
  onEvent('file.uploaded', async (event) => {
    await enqueue('file.index', { fileId: event.payload.fileId });
    if (event.payload.mimeType.startsWith('image/')) {
      await enqueue('file.thumbnail', {
        fileId: event.payload.fileId,
        organizationId: event.payload.organizationId,
      });
    }
  });

  onEvent('file.updated', async (event) => {
    await enqueue('file.index', { fileId: event.payload.fileId });
  });

  onEvent('file.deleted', async (event) => {
    await enqueue('file.purge', { storageKeys: event.payload.storageKeys });
  });

  onEvent('file.shared', async (event) => {
    if (event.payload.principalType !== 'user' || !event.payload.principalId) return;

    const file = await findFileByIdUnscoped(event.payload.fileId);
    const actor = await findUserById(event.payload.actorId);
    if (!file) return;

    await withTransaction((tx) =>
      createNotification(tx, {
        organizationId: event.payload.organizationId,
        userId: event.payload.principalId!,
        type: 'file.shared',
        title: `${actor?.full_name ?? 'Someone'} shared "${file.name}" with you`,
        body: `You now have ${event.payload.role} access.`,
        data: { fileId: file.id, role: event.payload.role },
      }),
    );
  });

  onEvent('mail.received', async (event) => {
    await withTransaction((tx) =>
      createNotification(tx, {
        organizationId: event.payload.organizationId,
        userId: event.payload.userId,
        type: 'mail.received',
        title: 'New message',
        body: 'You have received a new email.',
        data: { emailId: event.payload.emailId },
      }),
    );
  });

  onEvent('user.registered', async (event) => {
    await withTransaction((tx) =>
      createNotification(tx, {
        organizationId: event.payload.organizationId,
        userId: event.payload.userId,
        type: 'welcome',
        title: 'Welcome to Drive OSX',
        body: 'Your workspace is ready. Start by uploading a file or creating a document.',
        data: {},
      }),
    );
  });

  onEvent('organization.member_added', async (event) => {
    await withTransaction((tx) =>
      createNotification(tx, {
        organizationId: event.payload.organizationId,
        userId: event.payload.userId,
        type: 'organization.joined',
        title: 'You were added to a workspace',
        body: `Your role is ${event.payload.role}.`,
        data: { organizationId: event.payload.organizationId, role: event.payload.role },
      }),
    );
  });
}

function registerQueueHandlers(): void {
  /**
   * Extracts searchable text so search never has to read object storage.
   * Only text-like files are handled here; PDFs and images would need
   * extraction/OCR, which is not part of this build.
   */
  registerJobHandler<{ fileId: string }>('file.index', async ({ fileId }) => {
    const file = await findFileByIdUnscoped(fileId);
    if (!file || file.type === 'folder' || !file.storage_key) return;

    if (!isTextLike(file.mime_type)) {
      logger().debug({ fileId, mimeType: file.mime_type }, 'skipping text extraction for non-text file');
      return;
    }

    if (Number(file.size) > 5 * 1024 * 1024) {
      logger().info({ fileId, size: file.size }, 'file too large for inline text indexing');
      return;
    }

    const buffer = await objectStorage.getBuffer(file.storage_key);
    await setContentText(fileId, buffer.toString('utf8').slice(0, 500_000));
    logger().debug({ fileId }, 'file indexed for search');
  });

  /**
   * Publishes a preview object for images. Downscaling requires an image
   * library, which is not a dependency of this service — the preview is the
   * original until one is introduced.
   */
  registerJobHandler<{ fileId: string; organizationId: string }>(
    'file.thumbnail',
    async ({ fileId, organizationId }) => {
      const file = await findFileByIdUnscoped(fileId);
      if (!file?.storage_key || !file.mime_type.startsWith('image/')) return;

      await objectStorage.copy(file.storage_key, objectKeys.preview(organizationId, fileId));
      logger().debug({ fileId }, 'preview object published');
    },
  );

  registerJobHandler<{ storageKeys: string[] }>('file.purge', async ({ storageKeys }) => {
    await purgeStoredObjects(storageKeys);
  });

  registerJobHandler<{ userId: string; title: string; body: string; organizationId: string | null }>(
    'notification.dispatch',
    async (payload) => {
      await withTransaction((tx) =>
        createNotification(tx, {
          organizationId: payload.organizationId,
          userId: payload.userId,
          type: 'system',
          title: payload.title,
          body: payload.body,
        }),
      );
    },
  );
}
