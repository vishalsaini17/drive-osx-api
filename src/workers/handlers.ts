import { queryMany, queryOne, withTransaction } from '../infrastructure/database/pool.js';
import { logger } from '../infrastructure/observability/logger.js';
import { enqueue, registerJobHandler } from '../infrastructure/queue/queue.js';
import { objectKeys } from '../infrastructure/storage/object-storage.js';
import { objectStorage } from '../infrastructure/storage/s3-object-storage.js';
import { onEvent } from '../platform/events/event-bus.js';
import { findFileByIdUnscoped, setContentText } from '../modules/files/files.repository.js';
import { placeChatAttachment, purgeStoredObjects } from '../modules/files/files.service.js';
import { isTextLike } from '../modules/files/files.types.js';
import { createNotification } from '../modules/notifications/notifications.service.js';
import { deliverQueuedEmail } from '../modules/mail/mail.service.js';
import { findUserById } from '../modules/identity/identity.repository.js';
import { findPersonalOrganizationByOwner } from '../modules/organizations/organizations.repository.js';

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

  // Fires only after the transaction that inserted these rows has actually
  // committed (transactional outbox — see event-bus.ts), so the delivery
  // rows are guaranteed visible by the time the job runs.
  onEvent('mail.sent', async (event) => {
    const queued = await queryMany<{ id: string }>(
      `SELECT id FROM email_deliveries WHERE email_id = $1 AND status = 'queued'`,
      [event.payload.emailId],
    );
    for (const delivery of queued) {
      await enqueue('mail.deliver', { deliveryId: delivery.id });
    }
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

  // --- messaging ----------------------------------------------------------
  //
  // A chat request that produces no notification is only discoverable by
  // opening Messenger and looking for it, which is how the request flow
  // stalls. Each handler notifies the counterpart, never the actor.

  onEvent('chat.request_sent', async (event) => {
    const requester = await findUserById(event.payload.requesterId);

    await withTransaction((tx) =>
      createNotification(tx, {
        organizationId: event.payload.organizationId,
        userId: event.payload.recipientId,
        type: 'chat.request_received',
        title: `${requester?.full_name ?? 'Someone'} wants to chat`,
        body: 'Accept the request to start a conversation.',
        data: { requestId: event.payload.requestId, requesterId: event.payload.requesterId },
      }),
    );
  });

  onEvent('chat.request_accepted', async (event) => {
    const recipient = await findUserById(event.payload.recipientId);

    // The person who accepted already knows; tell the one who asked.
    await withTransaction((tx) =>
      createNotification(tx, {
        organizationId: event.payload.organizationId,
        userId: event.payload.requesterId,
        type: 'chat.request_accepted',
        title: `${recipient?.full_name ?? 'Your request'} accepted your chat request`,
        body: 'You can now send messages.',
        data: {
          conversationId: event.payload.conversationId,
          recipientId: event.payload.recipientId,
        },
      }),
    );
  });

  onEvent('chat.message_sent', async (event) => {
    const sender = await findUserById(event.payload.senderId);

    // The message text, so the notification can show a preview rather than
    // "you have a message" — a system notification the recipient cannot read
    // without opening the app is barely worth raising.
    const message = await queryOne<{ body: string; attachments: StoredAttachmentPayload[] }>(
      `SELECT body, attachments FROM messages WHERE id = $1 AND deleted_at IS NULL`,
      [event.payload.messageId],
    );

    // A deleted message should not resurface as a notification.
    if (!message) return;

    const preview = message.body.length > 140 ? `${message.body.slice(0, 139)}…` : message.body;

    // Every participant except the sender. Group conversations fan out here
    // too, so this does not need revisiting when they arrive.
    const recipients = await queryMany<{ user_id: string }>(
      `SELECT cp.user_id
         FROM conversation_participants cp
        WHERE cp.conversation_id = $1
          AND cp.user_id <> $2
          AND cp.is_muted = false`,
      [event.payload.conversationId, event.payload.senderId],
    );

    for (const recipient of recipients) {
      await withTransaction((tx) =>
        createNotification(tx, {
          organizationId: event.payload.organizationId,
          userId: recipient.user_id,
          type: 'chat.message',
          title: sender?.full_name ?? 'New message',
          body: preview,
          data: {
            conversationId: event.payload.conversationId,
            // Carried so a client can recognise a message it has already shown
            // and not raise the same notification twice.
            messageId: event.payload.messageId,
            senderId: event.payload.senderId,
            senderName: sender?.full_name ?? 'Someone',
            // Tells the shell which application to open on a click.
            appId: 'messenger',
          },
        }),
      );
    }

    // File media messages into everyone's own Drive too (CLAUDE.md §24: the
    // same event that raised the notifications above also drives this side
    // effect). Notifications above are skipped for a muted conversation;
    // this isn't, since muting notifications is not the same as not wanting
    // the media filed away.
    if (message.attachments?.length) {
      await mirrorChatAttachmentsToDrive(
        event.payload.conversationId,
        event.payload.senderId,
        message.attachments,
      );
    }
  });
}

interface StoredAttachmentPayload {
  id: string;
  kind: 'voice' | 'image' | 'video' | 'file';
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  durationSeconds?: number;
}

/**
 * Files every attachment on a message into each participant's own Drive —
 * `Chat/<peer>/Sent` for the sender, `Chat/<peer>/Received` for everyone
 * else — so media exchanged in a chat is easy to find later without
 * re-opening the conversation. `<peer>` is the other person's username for a
 * direct conversation, or the group's title for a group one.
 *
 * Best-effort and per-participant: one person's Drive being over quota, or
 * not having a personal organization to file into, must not stop the others
 * — the chat message itself is already committed by the time this runs.
 */
async function mirrorChatAttachmentsToDrive(
  conversationId: string,
  senderId: string,
  attachments: StoredAttachmentPayload[],
): Promise<void> {
  const conversation = await queryOne<{ kind: string; title: string | null }>(
    `SELECT kind, title FROM conversations WHERE id = $1`,
    [conversationId],
  );
  if (!conversation) return;

  const participants = await queryMany<{ user_id: string; username: string }>(
    `SELECT cp.user_id, u.username
       FROM conversation_participants cp
       JOIN users u ON u.id = cp.user_id
      WHERE cp.conversation_id = $1`,
    [conversationId],
  );

  const sender = participants.find((p) => p.user_id === senderId);
  const recipients = participants.filter((p) => p.user_id !== senderId);
  if (!sender) return;

  const isGroup = conversation.kind === 'group';
  const groupTitle = conversation.title?.trim() || 'Group chat';
  const sentPeerLabel = isGroup ? groupTitle : recipients[0]?.username ?? 'Unknown';
  const receivedPeerLabel = isGroup ? groupTitle : sender.username;

  for (const attachment of attachments) {
    let buffer: Buffer;
    try {
      buffer = await objectStorage.getBuffer(attachment.storageKey);
    } catch (error) {
      logger().error(
        { err: error, attachmentId: attachment.id },
        'failed to read chat attachment for Drive mirroring',
      );
      continue;
    }

    await fileChatAttachmentFor(sender.user_id, sentPeerLabel, 'Sent', attachment, buffer);
    for (const recipient of recipients) {
      await fileChatAttachmentFor(recipient.user_id, receivedPeerLabel, 'Received', attachment, buffer);
    }
  }
}

async function fileChatAttachmentFor(
  userId: string,
  peerLabel: string,
  direction: 'Sent' | 'Received',
  attachment: StoredAttachmentPayload,
  buffer: Buffer,
): Promise<void> {
  try {
    const org = await findPersonalOrganizationByOwner(userId);
    if (!org) return;

    await placeChatAttachment({
      actor: { userId, organizationId: org.id },
      peerLabel,
      direction,
      filename: attachment.name,
      buffer,
      mimeType: attachment.mimeType,
    });
  } catch (error) {
    logger().error(
      { err: error, userId, direction, attachmentId: attachment.id },
      'failed to mirror chat attachment into Drive',
    );
  }
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

  registerJobHandler<{ deliveryId: string }>('mail.deliver', async ({ deliveryId }, job) => {
    await deliverQueuedEmail(deliveryId, { attempts: job.attempts, maxAttempts: job.maxAttempts });
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
