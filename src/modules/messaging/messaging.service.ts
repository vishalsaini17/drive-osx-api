import { AppError } from '../../platform/errors/app-error.js';
import { publishEvent } from '../../platform/events/event-bus.js';
import { requireMembership } from '../../platform/authorization/access-control.js';
import { query, queryMany, queryOne, withTransaction } from '../../infrastructure/database/pool.js';
import { effectivePresence } from '../contacts/contacts.service.js';

/**
 * Direct messaging.
 *
 * Messaging is gated by a chat request: two users cannot exchange messages
 * until one has accepted the other's request. Accepting creates the
 * conversation and both contact rows in a single transaction, so a user can
 * never end up in a conversation they are not a contact of, or vice versa.
 */

export interface Actor {
  userId: string;
  organizationId: string;
}

export interface UserSummary {
  id: string;
  username: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  status: 'online' | 'away' | 'busy' | 'dnd' | 'offline';
  statusText: string;
  statusEmoji: string;
  lastSeenAt: string | null;
}

export interface ChatRequestView {
  id: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  message: string;
  createdAt: string;
  respondedAt: string | null;
  counterpart: UserSummary;
}

export interface ConversationView {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  topic: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  unreadCount: number;
  isMuted: boolean;
  isPinned: boolean;
  participants: UserSummary[];
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string | null;
  senderName: string;
  body: string;
  threadParentId: string | null;
  replyToId: string | null;
  attachments: unknown[];
  reactions: Record<string, string[]>;
  mentions: string[];
  isEdited: boolean;
  isMine: boolean;
  createdAt: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  body: string;
  thread_parent_id: string | null;
  reply_to_id: string | null;
  attachments: unknown[];
  reactions: Record<string, string[]>;
  mentions: string[];
  is_edited: boolean;
  created_at: string;
}

const USER_COLUMNS = `
  u.id, u.username, u.full_name, u.email, u.avatar_url,
  coalesce(p.status, 'offline') AS status,
  coalesce(p.status_text, '') AS status_text,
  coalesce(p.status_emoji, '') AS status_emoji,
  p.last_seen_at
`;

function mapUser(row: Record<string, any>): UserSummary {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    avatarUrl: row.avatar_url ?? null,
    // The stored row can't be trusted on its own — a browser that closes,
    // crashes, or loses its network never gets to write 'offline', so this
    // decays a stale heartbeat the same way contacts.service's presenceFor
    // does (see effectivePresence's doc comment).
    status: effectivePresence({ status: row.status, lastSeenAt: row.last_seen_at }),
    statusText: row.status_text ?? '',
    statusEmoji: row.status_emoji ?? '',
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Directory search
// ---------------------------------------------------------------------------

/**
 * Finds people to start a chat with.
 *
 * Reachability and enumerability are deliberately different rules:
 *
 * - An **exact** username or email resolves platform-wide. Registration gives
 *   every user their own `personal` organization, so scoping discovery to the
 *   caller's organization would mean nobody can ever find anybody — a username
 *   has to work as an address, the way it does in any messenger.
 * - A **substring** match is restricted to people who share an organization
 *   with the caller. Without that, a two-character query would walk the entire
 *   user table and turn this endpoint into a directory dump.
 *
 * The actor is never in their own results.
 */
export async function searchUsers(actor: Actor, term: string, limit = 20): Promise<UserSummary[]> {
  await requireMembership(actor.userId, actor.organizationId);

  const trimmed = term.trim();
  if (trimmed.length < 2) return [];

  const rows = await queryMany(
    `SELECT ${USER_COLUMNS}
       FROM users u
       LEFT JOIN user_presence p ON p.user_id = u.id
      WHERE u.id <> $1
        AND u.status = 'active'
        AND (
          lower(u.username) = lower($2)
          OR lower(u.email) = lower($2)
          OR (
            (u.username ILIKE $3 OR u.full_name ILIKE $3 OR u.email ILIKE $3)
            AND EXISTS (
              SELECT 1
                FROM memberships mine
                JOIN memberships theirs ON theirs.organization_id = mine.organization_id
               WHERE mine.user_id = $1
                 AND theirs.user_id = u.id
                 AND mine.status = 'active'
                 AND theirs.status = 'active'
            )
          )
        )
      ORDER BY (lower(u.username) = lower($2)) DESC,
               (u.username ILIKE $4) DESC,
               u.full_name
      LIMIT $5`,
    [actor.userId, trimmed, `%${trimmed}%`, `${trimmed}%`, limit],
  );

  return rows.map(mapUser);
}

// ---------------------------------------------------------------------------
// Chat requests
// ---------------------------------------------------------------------------

/**
 * Pending requests in both directions.
 *
 * Scoped by *involvement*, not by organization. A request row carries the
 * requester's organization, so filtering on the caller's own organization
 * would hide every incoming request that crossed a tenant boundary — which is
 * every request between two personal organizations.
 */
export async function listChatRequests(actor: Actor): Promise<ChatRequestView[]> {
  await requireMembership(actor.userId, actor.organizationId);

  const rows = await queryMany(
    // `r.id` must be aliased: USER_COLUMNS also selects `u.id`, and a driver
    // building row objects keeps the last column of a duplicated name. Without
    // the alias, `row.id` is the counterpart's user id, and every accept or
    // decline is sent for an id that does not exist in chat_requests.
    `SELECT r.id AS request_id, r.status, r.message, r.created_at, r.responded_at,
            r.requester_id, r.recipient_id, ${USER_COLUMNS}
       FROM chat_requests r
       JOIN users u
         ON u.id = CASE WHEN r.requester_id = $1 THEN r.recipient_id ELSE r.requester_id END
       LEFT JOIN user_presence p ON p.user_id = u.id
      WHERE (r.requester_id = $1 OR r.recipient_id = $1)
        AND r.status = 'pending'
      ORDER BY r.created_at DESC`,
    [actor.userId],
  );

  return rows.map((row) => ({
    id: row.request_id,
    direction: row.requester_id === actor.userId ? 'outgoing' : 'incoming',
    status: row.status,
    message: row.message,
    createdAt: new Date(row.created_at).toISOString(),
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    counterpart: mapUser(row),
  }));
}

/** Sends a chat request carrying a short introduction. */
export async function sendChatRequest(
  actor: Actor,
  input: { recipientId: string; message: string },
): Promise<ChatRequestView> {
  await requireMembership(actor.userId, actor.organizationId);

  if (input.recipientId === actor.userId) {
    throw AppError.validation('You cannot send a chat request to yourself');
  }

  // Any active user can be asked. Discovery is what is restricted (see
  // searchUsers) — once someone has been found, requiring them to be a
  // co-member as well would block every request between personal
  // organizations, which is the normal case.
  const recipient = await queryOne(
    `SELECT id FROM users WHERE id = $1 AND status = 'active'`,
    [input.recipientId],
  );
  if (!recipient) throw AppError.notFound('That user was not found');

  // An existing conversation means there is nothing to request.
  if (await findDirectConversationId(actor.userId, input.recipientId)) {
    throw AppError.conflict('You can already message this person');
  }

  const existing = await queryOne<{ id: string; requester_id: string }>(
    `SELECT id, requester_id FROM chat_requests
      WHERE status = 'pending'
        AND least(requester_id, recipient_id) = least($1::uuid, $2::uuid)
        AND greatest(requester_id, recipient_id) = greatest($1::uuid, $2::uuid)`,
    [actor.userId, input.recipientId],
  );
  if (existing) {
    throw AppError.conflict(
      existing.requester_id === actor.userId
        ? 'You already have a pending request with this person'
        : 'This person has already sent you a request',
    );
  }

  const row = await queryOne(
    `INSERT INTO chat_requests (organization_id, requester_id, recipient_id, message)
          VALUES ($1, $2, $3, $4)
       RETURNING id, status, message, created_at, responded_at, requester_id, recipient_id`,
    [actor.organizationId, actor.userId, input.recipientId, input.message.trim().slice(0, 280)],
  );
  if (!row) throw AppError.internal('Chat request could not be created');

  await publishEvent(
    { query },
    'chat.request_sent',
    {
      organizationId: actor.organizationId,
      requestId: row.id,
      requesterId: actor.userId,
      recipientId: input.recipientId,
    },
    { organizationId: actor.organizationId, actorId: actor.userId },
  );

  const counterpart = await queryOne(
    `SELECT ${USER_COLUMNS} FROM users u
       LEFT JOIN user_presence p ON p.user_id = u.id WHERE u.id = $1`,
    [input.recipientId],
  );
  if (!counterpart) throw AppError.notFound('That user was not found');

  return {
    id: row.id,
    direction: 'outgoing',
    status: row.status,
    message: row.message,
    createdAt: new Date(row.created_at).toISOString(),
    respondedAt: null,
    counterpart: mapUser(counterpart),
  };
}

/**
 * Accepts a request. The conversation and both contact rows are created in one
 * transaction so the three can never disagree.
 */
export async function respondToChatRequest(
  actor: Actor,
  requestId: string,
  action: 'accept' | 'reject',
): Promise<{ status: string; conversationId: string | null }> {
  await requireMembership(actor.userId, actor.organizationId);

  return withTransaction(async (tx) => {
    const request = await tx
      .query(
        `SELECT id, requester_id, recipient_id, status, organization_id
           FROM chat_requests
          WHERE id = $1
            FOR UPDATE`,
        [requestId],
      )
      .then((result) => result.rows[0]);

    if (!request) throw AppError.notFound('Request not found');
    if (request.recipient_id !== actor.userId) {
      throw AppError.permission('Only the recipient can respond to this request');
    }
    if (request.status !== 'pending') {
      throw AppError.conflict('This request has already been answered');
    }

    if (action === 'reject') {
      await tx.query(
        `UPDATE chat_requests SET status = 'rejected', responded_at = now() WHERE id = $1`,
        [requestId],
      );
      return { status: 'rejected', conversationId: null };
    }

    await tx.query(
      `UPDATE chat_requests SET status = 'accepted', responded_at = now() WHERE id = $1`,
      [requestId],
    );

    const conversationId = await createDirectConversationTx(
      tx,
      request.organization_id,
      request.requester_id,
      request.recipient_id,
    );

    // Each side gets the other in their contacts, sourced as a chat request.
    await addContactTx(tx, request.organization_id, request.recipient_id, request.requester_id);
    await addContactTx(tx, request.organization_id, request.requester_id, request.recipient_id);

    // Written in the same transaction as the state change it describes.
    await publishEvent(
      tx,
      'chat.request_accepted',
      {
        organizationId: request.organization_id,
        requestId,
        conversationId,
        requesterId: request.requester_id,
        recipientId: request.recipient_id,
      },
      { organizationId: request.organization_id, actorId: actor.userId },
    );

    return { status: 'accepted', conversationId };
  });
}

export async function cancelChatRequest(actor: Actor, requestId: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  const result = await query(
    `UPDATE chat_requests SET status = 'cancelled', responded_at = now()
      WHERE id = $1 AND requester_id = $2 AND status = 'pending'`,
    [requestId, actor.userId],
  );
  if (result.rowCount === 0) {
    throw AppError.notFound('No pending request to cancel');
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

async function findDirectConversationId(userA: string, userB: string): Promise<string | null> {
  const [a, b] = [userA, userB].sort();
  const row = await queryOne<{ conversation_id: string }>(
    `SELECT conversation_id FROM direct_conversation_keys WHERE user_a_id = $1 AND user_b_id = $2`,
    [a, b],
  );
  return row?.conversation_id ?? null;
}

async function createDirectConversationTx(
  tx: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  organizationId: string,
  userA: string,
  userB: string,
): Promise<string> {
  const [a, b] = [userA, userB].sort();

  const existing = await tx.query(
    `SELECT conversation_id FROM direct_conversation_keys WHERE user_a_id = $1 AND user_b_id = $2`,
    [a, b],
  );
  if (existing.rows[0]) return existing.rows[0].conversation_id;

  const conversation = await tx.query(
    `INSERT INTO conversations (organization_id, kind, created_by) VALUES ($1, 'direct', $2) RETURNING id`,
    [organizationId, userA],
  );
  const conversationId = conversation.rows[0].id;

  await tx.query(
    `INSERT INTO conversation_participants (conversation_id, user_id, role)
          VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [conversationId, userA, userB],
  );
  await tx.query(
    `INSERT INTO direct_conversation_keys (conversation_id, user_a_id, user_b_id) VALUES ($1, $2, $3)`,
    [conversationId, a, b],
  );

  return conversationId;
}

async function addContactTx(
  tx: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  organizationId: string,
  ownerId: string,
  contactUserId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO contacts (organization_id, owner_id, contact_user_id, display_name, email, source)
     SELECT $1, $2, u.id, u.full_name, u.email, 'chat_request'
       FROM users u WHERE u.id = $3
     ON CONFLICT (owner_id, contact_user_id) WHERE contact_user_id IS NOT NULL DO NOTHING`,
    [organizationId, ownerId, contactUserId],
  );
}

/**
 * The caller's conversations.
 *
 * Access to a conversation is *participation*, enforced by the join on
 * `conversation_participants` — the same rule `assertParticipant` applies to
 * messages. `conversations.organization_id` records where the conversation
 * originated (the requester's tenant) and is kept for audit, but it is not an
 * access boundary: using it as one made a conversation visible to whoever
 * started it and invisible to the person who accepted.
 */
export async function listConversations(actor: Actor): Promise<ConversationView[]> {
  await requireMembership(actor.userId, actor.organizationId);

  const rows = await queryMany(
    `SELECT c.id, c.kind, c.title, c.topic, c.last_message_at, c.last_message_preview,
            cp.is_muted, cp.is_pinned, cp.last_read_at,
            (SELECT count(*) FROM messages m
              WHERE m.conversation_id = c.id
                AND m.deleted_at IS NULL
                AND m.sender_id <> $1
                AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)
            ) AS unread_count
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
      ORDER BY cp.is_pinned DESC, c.last_message_at DESC NULLS LAST`,
    [actor.userId],
  );

  if (rows.length === 0) return [];

  const participants = await queryMany(
    `SELECT cp.conversation_id, ${USER_COLUMNS}
       FROM conversation_participants cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN user_presence p ON p.user_id = u.id
      WHERE cp.conversation_id = ANY($1::uuid[])`,
    [rows.map((row) => row.id)],
  );

  const byConversation = new Map<string, UserSummary[]>();
  for (const row of participants) {
    const list = byConversation.get(row.conversation_id) ?? [];
    list.push(mapUser(row));
    byConversation.set(row.conversation_id, list);
  }

  return rows.map((row) => {
    const members = byConversation.get(row.id) ?? [];
    const others = members.filter((member) => member.id !== actor.userId);
    return {
      id: row.id,
      kind: row.kind,
      // A direct conversation is named after the other person.
      title: row.title ?? (others[0]?.fullName || 'Conversation'),
      topic: row.topic ?? null,
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      lastMessagePreview: row.last_message_preview ?? '',
      unreadCount: Number(row.unread_count ?? 0),
      isMuted: row.is_muted,
      isPinned: row.is_pinned,
      participants: members,
    };
  });
}

async function assertParticipant(conversationId: string, userId: string): Promise<void> {
  const row = await queryOne(
    `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  if (!row) {
    throw AppError.permission('You are not part of this conversation');
  }
}

export async function listMessages(
  actor: Actor,
  conversationId: string,
  options: { limit?: number; before?: string } = {},
): Promise<MessageView[]> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);

  const limit = Math.min(options.limit ?? 50, 200);
  const rows = await queryMany(
    `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.thread_parent_id, m.reply_to_id,
            m.attachments, m.reactions, m.mentions, m.is_edited, m.created_at,
            coalesce(u.full_name, 'Removed user') AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1
        AND m.deleted_at IS NULL
        AND ($2::timestamptz IS NULL OR m.created_at < $2)
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [conversationId, options.before ?? null, limit],
  );

  // Query is newest-first for the limit; the client wants oldest-first.
  return rows.reverse().map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    body: row.body,
    threadParentId: row.thread_parent_id,
    replyToId: row.reply_to_id,
    attachments: row.attachments ?? [],
    reactions: row.reactions ?? {},
    mentions: row.mentions ?? [],
    isEdited: row.is_edited,
    isMine: row.sender_id === actor.userId,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function sendMessage(
  actor: Actor,
  conversationId: string,
  input: { body: string; replyToId?: string; threadParentId?: string; mentions?: string[] },
): Promise<MessageView> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);

  const body = input.body.trim();
  if (!body) throw AppError.validation('A message cannot be empty');

  const row = await withTransaction(async (tx) => {
    const inserted = await tx.query<MessageRow>(
      `INSERT INTO messages (conversation_id, organization_id, sender_id, body, reply_to_id, thread_parent_id, mentions)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, conversation_id, sender_id, body, thread_parent_id, reply_to_id,
                   attachments, reactions, mentions, is_edited, created_at`,
      [
        conversationId,
        actor.organizationId,
        actor.userId,
        body,
        input.replyToId ?? null,
        input.threadParentId ?? null,
        input.mentions ?? [],
      ],
    );

    const stored = inserted.rows[0];
    if (!stored) throw AppError.internal('Message could not be stored');

    // Keep the denormalised preview in step with the message that caused it.
    await tx.query(
      `UPDATE conversations
          SET last_message_at = now(), last_message_preview = $2
        WHERE id = $1`,
      [conversationId, body.slice(0, 160)],
    );

    // The sender has by definition read their own message.
    await tx.query(
      `UPDATE conversation_participants SET last_read_at = now()
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, actor.userId],
    );

    await publishEvent(
      tx,
      'chat.message_sent',
      {
        organizationId: actor.organizationId,
        conversationId,
        messageId: stored.id,
        senderId: actor.userId,
      },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );

    return stored;
  });

  const sender = await queryOne<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [
    actor.userId,
  ]);

  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: sender?.full_name ?? 'You',
    body: row.body,
    threadParentId: row.thread_parent_id,
    replyToId: row.reply_to_id,
    attachments: row.attachments ?? [],
    reactions: row.reactions ?? {},
    mentions: row.mentions ?? [],
    isEdited: row.is_edited,
    isMine: true,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function markConversationRead(actor: Actor, conversationId: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);
  await query(
    `UPDATE conversation_participants SET last_read_at = now()
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, actor.userId],
  );
}

export async function deleteMessage(actor: Actor, messageId: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  const result = await query(
    `UPDATE messages SET deleted_at = now()
      WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL`,
    [messageId, actor.userId],
  );
  if (result.rowCount === 0) {
    throw AppError.notFound('Message not found, or it is not yours to delete');
  }
}
