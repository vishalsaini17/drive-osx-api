import { AppError } from '../../platform/errors/app-error.js';
import { publishEvent } from '../../platform/events/event-bus.js';
import { query, queryMany, queryOne, withTransaction } from '../../infrastructure/database/pool.js';
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
  from_address: string;
  to_address: string;
  cc_address: string | null;
  bcc_address: string | null;
  subject: string;
  body: string;
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
  id, user_id, from_address, to_address, cc_address, bcc_address, subject, body, folder,
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
  cc?: string;
  bcc?: string;
  priority?: 'low' | 'normal' | 'high';
  attachments?: EmailAttachment[];
}

export async function sendEmail(
  actor: { userId: string; organizationId: string },
  input: SendEmailInput,
): Promise<EmailView> {
  const sender = await findUserById(actor.userId);
  if (!sender) throw AppError.notFound('Sender not found');

  const isHighPriority = input.priority === 'high';
  const subject = isHighPriority ? `[URGENT] ${input.subject}` : input.subject;

  const row = await withTransaction(async (tx) => {
    const { rows } = await tx.query<EmailRow>(
      `INSERT INTO emails (organization_id, user_id, from_address, to_address, cc_address, bcc_address,
                           subject, body, folder, is_unread, is_starred, is_important, labels, attachments, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent', false, $9, $9, $10, $11, $12)
       RETURNING ${EMAIL_COLUMNS}`,
      [
        actor.organizationId,
        actor.userId,
        sender.email,
        input.to.trim().toLowerCase(),
        input.cc?.trim().toLowerCase() ?? null,
        input.bcc?.trim().toLowerCase() ?? null,
        subject,
        input.body ?? '',
        isHighPriority,
        isHighPriority ? ['Important'] : [],
        JSON.stringify(input.attachments ?? []),
        Buffer.byteLength(input.body ?? '', 'utf8'),
      ],
    );

    const created = rows[0]!;
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
