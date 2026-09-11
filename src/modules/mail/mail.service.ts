import { randomUUID } from 'node:crypto';
import { AppError } from '../../platform/errors/app-error.js';
import { publishEvent } from '../../platform/events/event-bus.js';
import { env } from '../../platform/configuration/env.js';
import { query, queryMany, queryOne, withTransaction, type Queryable } from '../../infrastructure/database/pool.js';
import { logger } from '../../infrastructure/observability/logger.js';
import { objectStorage } from '../../infrastructure/storage/s3-object-storage.js';
import { findUserByAnyIdentifier, findUserById } from '../identity/identity.repository.js';

export type MailFolder = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive';

export interface EmailAttachment {
  id: string;
  name: string;
  size: string;
  type: string;
  storageKey?: string;
}

export interface EmailView {
  id: string;
  _id: string;
  userId: string;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  subject: string;
  body: string;
  bodyHtml: string | null;
  folder: MailFolder;
  isUnread: boolean;
  isStarred: boolean;
  isPinned: boolean;
  isImportant: boolean;
  labels: string[];
  attachments: EmailAttachment[];
  dateISO: string;
  timestamp: string;
  createdAt: string;
}

interface EmailRow {
  id: string;
  user_id: string;
  message_id: string | null;
  from_address: string;
  to_address: string;
  cc_address: string | null;
  bcc_address: string | null;
  subject: string;
  body: string;
  body_html: string | null;
  folder: MailFolder;
  is_unread: boolean;
  is_starred: boolean;
  is_pinned: boolean;
  is_important: boolean;
  labels: string[];
  attachments: EmailAttachment[];
  sent_at: Date;
  created_at: Date;
}

const EMAIL_COLUMNS = `
  id, user_id, message_id, from_address, to_address, cc_address, bcc_address, subject, body, body_html, folder,
  is_unread, is_starred, is_pinned, is_important, labels, attachments, sent_at, created_at
`;

function toEmailView(row: EmailRow): EmailView {
  return {
    id: row.id,
    _id: row.id,
    userId: row.user_id,
    from: row.from_address,
    to: row.to_address,
    cc: row.cc_address,
    bcc: row.bcc_address,
    subject: row.subject,
    body: row.body,
    bodyHtml: row.body_html,
    folder: row.folder,
    isUnread: row.is_unread,
    isStarred: row.is_starred,
    isPinned: row.is_pinned,
    isImportant: row.is_important,
    labels: row.labels ?? [],
    attachments: row.attachments ?? [],
    dateISO: row.sent_at.toISOString(),
    timestamp: row.sent_at.toLocaleString('en-US'),
    createdAt: row.created_at.toISOString(),
  };
}

// --------------------------------------------------------------- delivery

export type DeliveryStatus = 'queued' | 'processing' | 'sent' | 'delivered' | 'failed' | 'retrying' | 'bounced';
type RecipientKind = 'to' | 'cc' | 'bcc';

const TERMINAL_STATUSES: DeliveryStatus[] = ['sent', 'delivered', 'failed', 'bounced'];

export interface EmailDeliveryView {
  id: string;
  recipientAddress: string;
  kind: RecipientKind;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  mxHost: string | null;
  updatedAt: string;
}

interface EmailDeliveryRow {
  id: string;
  email_id: string;
  recipient_address: string;
  kind: RecipientKind;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  mx_host: string | null;
  updated_at: Date;
}

function toDeliveryView(row: EmailDeliveryRow): EmailDeliveryView {
  return {
    id: row.id,
    recipientAddress: row.recipient_address,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    mxHost: row.mx_host,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Splits a "to"/"cc"/"bcc" field into individual normalized addresses. */
export function splitAddresses(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/<([^>]+)>/.exec(part)?.[1] ?? part).trim().toLowerCase());
}

function domainOf(address: string): string {
  const at = address.indexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

export function isLocalDomain(address: string): boolean {
  return domainOf(address) === env.MAIL_DOMAIN;
}

/**
 * Wraps a text/plain body, or a text/plain + text/html pair as
 * multipart/alternative, with its own top-level Content-Type header — usable
 * either as the whole message body or nested inside multipart/mixed.
 *
 * This is a deliberately small MIME builder: no header folding, no RFC 2047
 * encoding for non-ASCII subjects. Good enough to prove real SMTP delivery
 * end-to-end; a full MIME implementation is a separate slice.
 */
function buildBodyPart(email: EmailRow): string {
  if (!email.body_html) {
    return ['Content-Type: text/plain; charset="utf-8"', 'Content-Transfer-Encoding: 8bit', '', email.body || ''].join(
      '\r\n',
    );
  }

  const boundary = `alt-${randomUUID()}`;
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    email.body || '',
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    email.body_html,
    '',
    `--${boundary}--`,
  ].join('\r\n');
}

async function buildAttachmentPart(attachment: EmailAttachment): Promise<string> {
  const buffer = await objectStorage.getBuffer(attachment.storageKey!);
  return [
    `Content-Type: ${attachment.type || 'application/octet-stream'}; name="${attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    '',
    buffer.toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
}

/**
 * Composes a raw RFC 5322 message for one recipient. Attachments are only
 * included when `storageKey` is already populated (e.g. files attached via
 * the Drive picker); attachments without stored bytes are sent without
 * content — wiring compose-time uploads to object storage is a separate
 * slice.
 */
export async function buildRawMessage(email: EmailRow, recipient: string): Promise<string> {
  const messageId = email.message_id || `<${randomUUID()}@${env.MAIL_DOMAIN}>`;
  const headers = [
    `From: ${email.from_address}`,
    `To: ${recipient}`,
    `Subject: ${email.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];

  const attachments = (email.attachments ?? []).filter((attachment) => attachment.storageKey);

  if (attachments.length === 0) {
    return [...headers, buildBodyPart(email)].join('\r\n');
  }

  const boundary = `mixed-${randomUUID()}`;
  const parts = [buildBodyPart(email), ...(await Promise.all(attachments.map(buildAttachmentPart)))];
  const body = `${parts.map((part) => `--${boundary}\r\n${part}`).join('\r\n')}\r\n--${boundary}--`;

  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', body].join('\r\n');
}

/**
 * Minimal RFC-822 header extraction for messages delivered by the SMTP
 * gateway. Full parsing belongs in the mail service; the API only needs
 * enough to file the message correctly.
 */
export function parseRawMessage(raw: string): {
  from: string;
  to: string;
  subject: string;
  sentAt: string;
  body: string;
} {
  const header = (name: string): string => {
    const match = new RegExp(`^${name}:\\s*(.+)$`, 'mi').exec(raw);
    return match?.[1]?.trim() ?? '';
  };

  const rawDate = header('Date');
  const parsedDate = rawDate ? new Date(rawDate) : new Date();

  // A blank line separates headers from the body.
  const separator = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') + 4 : raw.indexOf('\n\n') + 2;

  return {
    from: header('From'),
    to: header('To'),
    subject: header('Subject'),
    sentAt: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
    body: separator > 1 ? raw.slice(separator) : raw,
  };
}

export interface ReceiveEmailInput {
  to: string;
  from: string;
  subject?: string;
  body?: string;
  recipientUsername?: string;
}

/** Called by the SMTP gateway when a message is delivered for a local mailbox. */
export async function receiveEmail(input: ReceiveEmailInput): Promise<EmailView> {
  const recipient =
    (input.recipientUsername ? await findUserByAnyIdentifier(input.recipientUsername) : null) ??
    (await findUserByAnyIdentifier(input.to));

  if (!recipient) {
    throw AppError.notFound(`No mailbox exists for "${input.to}"`);
  }

  const organizationId = recipient.current_organization_id ?? recipient.primary_organization_id;
  if (!organizationId) {
    throw AppError.validation('The recipient has no active workspace');
  }

  const parsed = parseRawMessage(input.body ?? '');

  const row = await withTransaction(async (tx) => {
    const { rows } = await tx.query<EmailRow>(
      `INSERT INTO emails (organization_id, user_id, from_address, to_address, subject, body, folder, sent_at, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, 'inbox', $7, $8)
       RETURNING ${EMAIL_COLUMNS}`,
      [
        organizationId,
        recipient.id,
        (parsed.from || input.from).toLowerCase(),
        (parsed.to || input.to).toLowerCase(),
        parsed.subject || input.subject || '(No subject)',
        parsed.body || input.body || '',
        parsed.sentAt,
        Buffer.byteLength(input.body ?? '', 'utf8'),
      ],
    );

    const created = rows[0]!;
    await publishEvent(
      tx,
      'mail.received',
      { organizationId, emailId: created.id, userId: recipient.id },
      { organizationId, actorId: recipient.id },
    );

    return created;
  });

  return toEmailView(row);
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body?: string;
  /**
   * Stored as-is; nothing here renders it. The client that reads it back
   * (the mail app's reading pane) is responsible for sanitizing before
   * putting it in the DOM — never trust stored email HTML (CLAUDE.md §28).
   */
  bodyHtml?: string;
  cc?: string;
  bcc?: string;
  priority?: 'low' | 'normal' | 'high';
  attachments?: EmailAttachment[];
}

/** Delivers directly into a fellow local mailbox — no SMTP hop, no queue. */
async function deliverLocally(
  tx: Queryable,
  created: EmailRow,
  mailbox: { id: string; current_organization_id: string | null; primary_organization_id: string | null },
  recipientAddress: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO emails (organization_id, user_id, message_id, from_address, to_address, subject, body, body_html, folder, attachments, sent_at, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'inbox', $9, now(), $10)`,
    [
      mailbox.current_organization_id ?? mailbox.primary_organization_id,
      mailbox.id,
      created.message_id,
      created.from_address,
      recipientAddress,
      created.subject,
      created.body,
      created.body_html,
      JSON.stringify(created.attachments ?? []),
      Buffer.byteLength(created.body ?? '', 'utf8'),
    ],
  );
}

export async function sendEmail(
  actor: { userId: string; organizationId: string },
  input: SendEmailInput,
): Promise<EmailView> {
  const sender = await findUserById(actor.userId);
  if (!sender) throw AppError.notFound('Sender not found');

  const isHighPriority = input.priority === 'high';
  const subject = isHighPriority ? `[URGENT] ${input.subject}` : input.subject;
  const messageId = `<${randomUUID()}@${env.MAIL_DOMAIN}>`;

  const recipients: { address: string; kind: RecipientKind }[] = [
    ...splitAddresses(input.to).map((address) => ({ address, kind: 'to' as const })),
    ...splitAddresses(input.cc).map((address) => ({ address, kind: 'cc' as const })),
    ...splitAddresses(input.bcc).map((address) => ({ address, kind: 'bcc' as const })),
  ];
  if (recipients.length === 0) throw AppError.validation('At least one recipient is required');

  const row = await withTransaction(async (tx) => {
    const { rows } = await tx.query<EmailRow>(
      `INSERT INTO emails (organization_id, user_id, message_id, from_address, to_address, cc_address, bcc_address,
                           subject, body, body_html, folder, is_unread, is_starred, is_important, labels, attachments, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'sent', false, $11, $11, $12, $13, $14)
       RETURNING ${EMAIL_COLUMNS}`,
      [
        actor.organizationId,
        actor.userId,
        messageId,
        sender.email,
        input.to.trim().toLowerCase(),
        input.cc?.trim().toLowerCase() ?? null,
        input.bcc?.trim().toLowerCase() ?? null,
        subject,
        input.body ?? '',
        input.bodyHtml ?? null,
        isHighPriority,
        isHighPriority ? ['Important'] : [],
        JSON.stringify(input.attachments ?? []),
        Buffer.byteLength(input.body ?? '', 'utf8'),
      ],
    );

    const created = rows[0]!;

    // Local delivery happens inline, in the same transaction: it's just a
    // second row insert, not a network call, so there's nothing to queue and
    // nothing that can fail asynchronously. External recipients are left
    // 'queued' — the mail.sent handler below enqueues them once this
    // transaction actually commits (CLAUDE.md §24: the transactional outbox
    // already guarantees that ordering for domain events).
    for (const recipient of recipients) {
      if (isLocalDomain(recipient.address)) {
        const mailbox = await findUserByAnyIdentifier(recipient.address);
        const organizationId = mailbox ? (mailbox.current_organization_id ?? mailbox.primary_organization_id) : null;

        if (mailbox && organizationId) {
          await deliverLocally(tx, created, mailbox, recipient.address);
          await tx.query(
            `INSERT INTO email_deliveries (email_id, recipient_address, kind, status) VALUES ($1, $2, $3, 'delivered')`,
            [created.id, recipient.address, recipient.kind],
          );
        } else {
          await tx.query(
            `INSERT INTO email_deliveries (email_id, recipient_address, kind, status, last_error) VALUES ($1, $2, $3, 'failed', $4)`,
            [created.id, recipient.address, recipient.kind, 'No mailbox exists for this address'],
          );
        }
        continue;
      }

      await tx.query(
        `INSERT INTO email_deliveries (email_id, recipient_address, kind, status) VALUES ($1, $2, $3, 'queued')`,
        [created.id, recipient.address, recipient.kind],
      );
    }

    await publishEvent(
      tx,
      'mail.sent',
      { organizationId: actor.organizationId, emailId: created.id, userId: actor.userId, to: input.to },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );

    return created;
  });

  return toEmailView(row);
}

export interface ListMailInput {
  userId: string;
  folder?: MailFolder | 'starred' | 'important';
  search?: string;
  limit: number;
  offset: number;
}

export async function listMail(input: ListMailInput): Promise<EmailView[]> {
  const isVirtualFolder = input.folder === 'starred' || input.folder === 'important';

  const rows = await queryMany<EmailRow>(
    `SELECT ${EMAIL_COLUMNS}
       FROM emails
      WHERE user_id = $1
        AND ($2::text IS NULL OR folder = $2::text)
        AND ($3::boolean = false OR is_starred)
        AND ($4::boolean = false OR is_important)
        AND ($5::text IS NULL OR search_vector @@ websearch_to_tsquery('english', $5))
      ORDER BY is_pinned DESC, sent_at DESC
      LIMIT $6 OFFSET $7`,
    [
      input.userId,
      isVirtualFolder || !input.folder ? null : input.folder,
      input.folder === 'starred',
      input.folder === 'important',
      input.search?.trim() || null,
      input.limit,
      input.offset,
    ],
  );

  return rows.map(toEmailView);
}

async function loadOwnedEmail(userId: string, emailId: string): Promise<EmailRow> {
  const row = await queryOne<EmailRow>(`SELECT ${EMAIL_COLUMNS} FROM emails WHERE id = $1`, [emailId]);
  if (!row) throw AppError.notFound('Message not found');
  if (row.user_id !== userId) {
    // Do not confirm that someone else's message exists.
    throw AppError.notFound('Message not found');
  }
  return row;
}

export async function getEmail(userId: string, emailId: string): Promise<EmailView> {
  return toEmailView(await loadOwnedEmail(userId, emailId));
}

export async function markRead(userId: string, emailId: string): Promise<EmailView> {
  await loadOwnedEmail(userId, emailId);
  const row = await queryOne<EmailRow>(
    `UPDATE emails SET is_unread = false WHERE id = $1 AND user_id = $2 RETURNING ${EMAIL_COLUMNS}`,
    [emailId, userId],
  );
  return toEmailView(row!);
}

export async function toggleFlag(
  userId: string,
  emailId: string,
  flag: 'is_starred' | 'is_pinned' | 'is_important',
): Promise<EmailView> {
  await loadOwnedEmail(userId, emailId);
  const row = await queryOne<EmailRow>(
    `UPDATE emails SET ${flag} = NOT ${flag} WHERE id = $1 AND user_id = $2 RETURNING ${EMAIL_COLUMNS}`,
    [emailId, userId],
  );
  return toEmailView(row!);
}

export async function moveToFolder(userId: string, emailId: string, folder: MailFolder): Promise<EmailView> {
  await loadOwnedEmail(userId, emailId);
  const row = await queryOne<EmailRow>(
    `UPDATE emails SET folder = $3 WHERE id = $1 AND user_id = $2 RETURNING ${EMAIL_COLUMNS}`,
    [emailId, userId, folder],
  );
  return toEmailView(row!);
}

/** Deleting from anywhere but the trash moves the message there first. */
export async function deleteEmail(userId: string, emailId: string): Promise<{ deleted: boolean }> {
  const email = await loadOwnedEmail(userId, emailId);

  if (email.folder !== 'trash') {
    await query('UPDATE emails SET folder = \'trash\' WHERE id = $1 AND user_id = $2', [emailId, userId]);
    return { deleted: false };
  }

  await query('DELETE FROM emails WHERE id = $1 AND user_id = $2', [emailId, userId]);
  return { deleted: true };
}

export async function unreadCount(userId: string, folder?: MailFolder): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*) AS count
       FROM emails
      WHERE user_id = $1 AND is_unread AND ($2::text IS NULL OR folder = $2::text)`,
    [userId, folder ?? null],
  );
  return Number(row?.count ?? 0);
}

export async function listDeliveries(userId: string, emailId: string): Promise<EmailDeliveryView[]> {
  await loadOwnedEmail(userId, emailId);
  const rows = await queryMany<EmailDeliveryRow>(
    `SELECT id, email_id, recipient_address, kind, status, attempts, last_error, mx_host, updated_at
       FROM email_deliveries
      WHERE email_id = $1
      ORDER BY created_at`,
    [emailId],
  );
  return rows.map(toDeliveryView);
}

async function markDeliveryOutcome(
  deliveryId: string,
  status: DeliveryStatus,
  fields: { mxHost?: string | null; lastError?: string | null; incrementAttempts?: boolean } = {},
): Promise<void> {
  await query(
    `UPDATE email_deliveries
        SET status = $2,
            mx_host = COALESCE($3, mx_host),
            last_error = $4,
            attempts = attempts + $5
      WHERE id = $1`,
    [deliveryId, status, fields.mxHost ?? null, fields.lastError ?? null, fields.incrementAttempts ? 1 : 0],
  );
}

/**
 * Runs on the `mail.deliver` queue job. Idempotent: a delivery already in a
 * terminal state (`sent`/`delivered`/`failed`/`bounced`) is a no-op, since
 * the queue's at-least-once delivery can re-dispatch a job that already
 * succeeded.
 *
 * Throwing lets `queue.ts`'s existing exponential backoff retry the job; a
 * permanent failure returns normally instead, so it is never retried.
 */
export async function deliverQueuedEmail(
  deliveryId: string,
  job: { attempts: number; maxAttempts: number },
): Promise<void> {
  const delivery = await queryOne<EmailDeliveryRow>(
    `SELECT id, email_id, recipient_address, kind, status, attempts, last_error, mx_host, updated_at
       FROM email_deliveries WHERE id = $1`,
    [deliveryId],
  );
  if (!delivery) {
    logger().warn({ deliveryId }, 'mail.deliver job references a delivery row that no longer exists');
    return;
  }
  if (TERMINAL_STATUSES.includes(delivery.status)) {
    logger().debug({ deliveryId, status: delivery.status }, 'delivery already resolved, skipping');
    return;
  }

  const email = await queryOne<EmailRow>(`SELECT ${EMAIL_COLUMNS} FROM emails WHERE id = $1`, [delivery.email_id]);
  if (!email) {
    await markDeliveryOutcome(deliveryId, 'failed', { lastError: 'Parent message no longer exists' });
    return;
  }

  await markDeliveryOutcome(deliveryId, 'processing');

  const raw = await buildRawMessage(email, delivery.recipient_address);
  const isFinalAttempt = job.attempts + 1 >= job.maxAttempts;

  let response: Response;
  try {
    response = await fetch(`${env.MAIL_GATEWAY_URL}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mail-Gateway-Token': env.MAIL_GATEWAY_TOKEN ?? '' },
      body: JSON.stringify({ envelopeFrom: email.from_address, envelopeTo: delivery.recipient_address, raw }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = (error as Error).message;
    await markDeliveryOutcome(deliveryId, isFinalAttempt ? 'failed' : 'retrying', {
      lastError: message,
      incrementAttempts: true,
    });
    if (isFinalAttempt) return;
    throw error;
  }

  const result = (await response.json().catch(() => ({}))) as { mxHost?: string; error?: string };

  if (response.ok) {
    await markDeliveryOutcome(deliveryId, 'sent', { mxHost: result.mxHost ?? null });
    return;
  }

  // The gateway maps a permanent SMTP rejection to 4xx and a retryable
  // failure (connection refused, greylisting, timeout) to 502.
  const permanent = response.status < 500;
  const errorMessage = result.error ?? `Outbound relay returned ${response.status}`;

  if (permanent) {
    await markDeliveryOutcome(deliveryId, 'failed', { lastError: errorMessage, mxHost: result.mxHost ?? null });
    return;
  }

  await markDeliveryOutcome(deliveryId, isFinalAttempt ? 'failed' : 'retrying', {
    lastError: errorMessage,
    mxHost: result.mxHost ?? null,
    incrementAttempts: true,
  });
  if (isFinalAttempt) return;
  throw new Error(errorMessage);
}

/**
 * Runs on the `mail.register-sender` queue job, fired once per signup
 * (`user.registered` handler). Registers the new mailbox address with the
 * gateway's outbound relay provider — needed because OCI Email Delivery (the
 * relay in use until outbound port 25 opens) only accepts mail from
 * addresses explicitly pre-approved in its console, checked against the
 * message's own `From:` header. Direct-to-MX delivery has no such concept,
 * so the gateway no-ops this when it isn't relaying through a provider that
 * needs it — this call is harmless either way.
 *
 * Not on the registration critical path: this runs from the background
 * queue precisely so a slow or momentarily-unavailable relay provider never
 * blocks or fails signup. Throwing retries with backoff, matching
 * deliverQueuedEmail above; a user who can already receive mail (inbound
 * never touches this) just can't send until this eventually succeeds.
 */
export async function provisionApprovedSender(
  emailAddress: string,
  job: { attempts: number; maxAttempts: number },
): Promise<void> {
  const isFinalAttempt = job.attempts + 1 >= job.maxAttempts;

  let response: Response;
  try {
    response = await fetch(`${env.MAIL_GATEWAY_URL}/provision-sender`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mail-Gateway-Token': env.MAIL_GATEWAY_TOKEN ?? '' },
      body: JSON.stringify({ emailAddress }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    logger().warn({ emailAddress, error: (error as Error).message }, 'sender provisioning request failed');
    if (isFinalAttempt) {
      logger().error({ emailAddress }, 'giving up on sender provisioning after final attempt');
      return;
    }
    throw error;
  }

  if (response.ok) {
    logger().debug({ emailAddress }, 'sender provisioned (or provisioning not required) with outbound relay');
    return;
  }

  const result = (await response.json().catch(() => ({}))) as { error?: string };
  const errorMessage = result.error ?? `Sender provisioning returned ${response.status}`;

  // Same convention as deliverQueuedEmail: the gateway maps a permanent
  // rejection to 4xx and a retryable failure (relay unreachable, rate
  // limited) to 502.
  const permanent = response.status < 500;
  if (permanent) {
    logger().error({ emailAddress, error: errorMessage }, 'sender provisioning permanently rejected');
    return;
  }

  logger().warn({ emailAddress, error: errorMessage }, 'sender provisioning failed, will retry');
  if (isFinalAttempt) {
    logger().error({ emailAddress }, 'giving up on sender provisioning after final attempt');
    return;
  }
  throw new Error(errorMessage);
}
