import { randomUUID } from 'node:crypto';
import { AppError } from '../../platform/errors/app-error.js';
import { publishEvent } from '../../platform/events/event-bus.js';
import { requireMembership } from '../../platform/authorization/access-control.js';
import { query, queryMany, queryOne, withTransaction } from '../../infrastructure/database/pool.js';
import { effectivePresence, isBlockedBetween } from '../contacts/contacts.service.js';
import { objectKeys } from '../../infrastructure/storage/object-storage.js';
import { objectStorage } from '../../infrastructure/storage/s3-object-storage.js';
import { recordAuditDetached } from '../audit/audit.service.js';

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

/** A sent message can only be edited within this window afterward. */
const EDIT_WINDOW_MS = 60_000;

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

/** A conversation participant, plus their role — only meaningful in group conversations (see the group info panel's admin badge). */
export interface ConversationParticipantView extends UserSummary {
  role: 'owner' | 'admin' | 'member';
}

export interface ConversationView {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  topic: string | null;
  /** A group's avatar — an emoji shorthand or an `http…` URL, same convention as `UserSummary.avatarUrl`. Null for direct chats. */
  avatarUrl: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  unreadCount: number;
  isMuted: boolean;
  isPinned: boolean;
  /** Per-viewer, independent of any contact record — the only kind of "favourite" a group can have. */
  isFavourite: boolean;
  participants: ConversationParticipantView[];
}

/**
 * An attachment as the API returns it. Stored (see `StoredAttachment` below)
 * with an object-storage key rather than a URL — a bucket is private, so a
 * usable link has to be minted fresh, with a short expiry, at read time.
 */
export interface MessageAttachmentView {
  id: string;
  kind: 'voice' | 'file' | 'image' | 'video';
  name: string;
  mimeType: string;
  size: number;
  url: string;
  durationSeconds?: number;
}

/** An attachment as it is stored in `messages.attachments` (jsonb). */
interface StoredAttachment {
  id: string;
  kind: 'voice' | 'file' | 'image' | 'video';
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  durationSeconds?: number;
}

/** Only meaningful for a message the caller sent — nobody sees ticks on a message they received. */
export type MessageDeliveryStatus = 'sent' | 'delivered' | 'read';

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string | null;
  senderName: string;
  body: string;
  threadParentId: string | null;
  replyToId: string | null;
  attachments: MessageAttachmentView[];
  reactions: Record<string, string[]>;
  mentions: string[];
  isEdited: boolean;
  isMine: boolean;
  /** Present only when `isMine` — single/double/blue tick. */
  status?: MessageDeliveryStatus;
  /** Set once this message is pinned in its conversation — see `setMessagePinned`. */
  pinnedAt: string | null;
  /** True for a message created by `forwardMessage` — the client's "Forwarded" label. */
  isForwarded: boolean;
  /**
   * True once the sender has deleted this message "for everyone" — `body`
   * and `attachments` are already cleared server-side at that point, so the
   * client just needs to know to render a placeholder instead of them.
   */
  isDeleted: boolean;
  createdAt: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  body: string;
  thread_parent_id: string | null;
  reply_to_id: string | null;
  attachments: StoredAttachment[];
  reactions: Record<string, string[]>;
  mentions: string[];
  is_edited: boolean;
  pinned_at: string | null;
  forwarded: boolean;
  deleted_at: string | null;
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

function mapParticipant(row: Record<string, any>): ConversationParticipantView {
  return { ...mapUser(row), role: row.role };
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

  if (await isBlockedBetween(actor.userId, input.recipientId)) {
    throw AppError.permission('You cannot send a chat request to this person');
  }

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
    `SELECT c.id, c.kind, c.title, c.topic, c.avatar_url, c.last_message_at, c.last_message_preview,
            cp.is_muted, cp.is_pinned, cp.is_favourite, cp.last_read_at,
            (SELECT count(*) FROM messages m
              WHERE m.conversation_id = c.id
                AND m.deleted_at IS NULL
                AND m.sender_id <> $1
                AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)
            ) AS unread_count
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
      WHERE cp.deleted_at IS NULL
      ORDER BY cp.is_pinned DESC, c.last_message_at DESC NULLS LAST`,
    [actor.userId],
  );

  if (rows.length === 0) return [];

  const participants = await queryMany(
    `SELECT cp.conversation_id, cp.role, ${USER_COLUMNS}
       FROM conversation_participants cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN user_presence p ON p.user_id = u.id
      WHERE cp.conversation_id = ANY($1::uuid[])
      -- Owner (and any admin) first, then by how long they've been a
      -- member — the order the group info panel's member list uses.
      ORDER BY (cp.role = 'owner') DESC, (cp.role = 'admin') DESC, cp.joined_at`,
    [rows.map((row) => row.id)],
  );

  const byConversation = new Map<string, ConversationParticipantView[]>();
  for (const row of participants) {
    const list = byConversation.get(row.conversation_id) ?? [];
    list.push(mapParticipant(row));
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
      avatarUrl: row.avatar_url ?? null,
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      lastMessagePreview: row.last_message_preview ?? '',
      unreadCount: Number(row.unread_count ?? 0),
      isMuted: row.is_muted,
      isFavourite: row.is_favourite,
      isPinned: row.is_pinned,
      participants: members,
    };
  });
}

export interface CreateGroupInput {
  title: string;
  /** Does not need to (and should not) include the creator. */
  memberUserIds: string[];
}

/**
 * Starts a group conversation. Membership is restricted to the caller's own
 * contacts, the same boundary direct messaging already has: without it, a
 * group would be a way to message a stranger you could not otherwise reach,
 * bypassing the chat-request flow entirely.
 */
export async function createGroupConversation(actor: Actor, input: CreateGroupInput): Promise<ConversationView> {
  await requireMembership(actor.userId, actor.organizationId);

  const title = input.title.trim();
  if (!title) throw AppError.validation('A group needs a name');

  const memberIds = Array.from(new Set(input.memberUserIds)).filter((id) => id !== actor.userId);
  if (memberIds.length < 2) throw AppError.validation('Pick at least 2 people to start a group');

  const contactRows = await queryMany<{ contact_user_id: string }>(
    `SELECT contact_user_id FROM contacts WHERE owner_id = $1 AND contact_user_id = ANY($2::uuid[])`,
    [actor.userId, memberIds],
  );
  if (contactRows.length !== memberIds.length) {
    throw AppError.validation('You can only add people from your contacts to a group');
  }

  const conversationId = await withTransaction(async (tx) => {
    const conversation = await tx.query<{ id: string }>(
      `INSERT INTO conversations (organization_id, kind, title, created_by) VALUES ($1, 'group', $2, $3) RETURNING id`,
      [actor.organizationId, title, actor.userId],
    );
    const id = conversation.rows[0]?.id;
    if (!id) throw AppError.internal('Group could not be created');

    await tx.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [id, actor.userId],
    );
    for (const memberId of memberIds) {
      await tx.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
        [id, memberId],
      );
    }

    await publishEvent(
      tx,
      'chat.group_created',
      { organizationId: actor.organizationId, conversationId: id, createdBy: actor.userId, memberIds },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );

    return id;
  });

  const conversations = await listConversations(actor);
  const created = conversations.find((conversation) => conversation.id === conversationId);
  if (!created) throw AppError.internal('Group could not be created');
  return created;
}

async function assertGroup(conversationId: string): Promise<void> {
  const conversation = await queryOne<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [
    conversationId,
  ]);
  if (!conversation) throw AppError.notFound('Conversation not found');
  if (conversation.kind !== 'group') throw AppError.validation('This is not a group conversation');
}

/** Renaming, re-describing, re-picturing, and adding members are admin-only — everyone can still view and message. */
async function assertGroupAdmin(conversationId: string, userId: string): Promise<void> {
  const participant = await queryOne<{ role: string }>(
    `SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  if (!participant || (participant.role !== 'owner' && participant.role !== 'admin')) {
    throw AppError.permission('Only a group admin can do that');
  }
}

/**
 * Adds a member to a group. Restricted to admins, and to the caller's own
 * contacts — the same boundary `createGroupConversation` has — otherwise a
 * group would be a side door for messaging someone you could not otherwise
 * reach.
 */
export async function addGroupMember(actor: Actor, conversationId: string, newMemberId: string): Promise<ConversationView> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertGroup(conversationId);
  await assertGroupAdmin(conversationId, actor.userId);

  if (newMemberId === actor.userId) throw AppError.validation('You are already in this group');

  const contact = await queryOne(
    `SELECT 1 FROM contacts WHERE owner_id = $1 AND contact_user_id = $2`,
    [actor.userId, newMemberId],
  );
  if (!contact) throw AppError.validation('You can only add people from your contacts to a group');

  const already = await queryOne(
    `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, newMemberId],
  );
  if (already) throw AppError.conflict('That person is already in the group');

  await query(
    `INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
    [conversationId, newMemberId],
  );

  const conversations = await listConversations(actor);
  const updated = conversations.find((conversation) => conversation.id === conversationId);
  if (!updated) throw AppError.internal('Group could not be updated');
  return updated;
}

/**
 * Leaving a group deletes the participant row outright — unlike
 * `deleteConversation`, there is no reviving it later; someone still in the
 * group has to add you back. If the owner leaves and others remain,
 * ownership passes to the longest-standing admin, or failing that the
 * longest-standing member, so the group is never left without one.
 */
export async function leaveGroupConversation(actor: Actor, conversationId: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);
  await assertGroup(conversationId);

  await withTransaction(async (tx) => {
    const self = await tx.query<{ role: string }>(
      `SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, actor.userId],
    );

    await tx.query(`DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`, [
      conversationId,
      actor.userId,
    ]);

    if (self.rows[0]?.role === 'owner') {
      const successor = await tx.query<{ user_id: string }>(
        `SELECT user_id FROM conversation_participants
          WHERE conversation_id = $1
          ORDER BY (role = 'admin') DESC, joined_at
          LIMIT 1`,
        [conversationId],
      );
      const successorId = successor.rows[0]?.user_id;
      if (successorId) {
        await tx.query(`UPDATE conversation_participants SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2`, [
          conversationId,
          successorId,
        ]);
      }
    }
  });
}

/** A group's description — `conversations.topic`, unused until now. Admin-only. */
export async function setGroupDescription(actor: Actor, conversationId: string, description: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertGroup(conversationId);
  await assertGroupAdmin(conversationId, actor.userId);

  await query(`UPDATE conversations SET topic = $2 WHERE id = $1`, [conversationId, description.trim().slice(0, 500)]);
}

/** A group's name. Admin-only. */
export async function renameGroup(actor: Actor, conversationId: string, title: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertGroup(conversationId);
  await assertGroupAdmin(conversationId, actor.userId);

  const trimmed = title.trim();
  if (!trimmed) throw AppError.validation('A group needs a name');

  await query(`UPDATE conversations SET title = $2 WHERE id = $1`, [conversationId, trimmed.slice(0, 120)]);
}

/**
 * A group's avatar — same convention as `users.avatar_url` (identity module):
 * an emoji shorthand or an `http…` image URL, set directly rather than
 * uploaded. Admin-only.
 */
export async function setGroupAvatar(actor: Actor, conversationId: string, avatarUrl: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertGroup(conversationId);
  await assertGroupAdmin(conversationId, actor.userId);

  const trimmed = avatarUrl.trim();
  if (trimmed.length > 500) throw AppError.validation('That avatar value is too long');

  await query(`UPDATE conversations SET avatar_url = $2 WHERE id = $1`, [conversationId, trimmed || null]);
}

/**
 * Favouriting is per-viewer and per-conversation, independent of any contact
 * record — the only kind of "favourite" a group can have, since it has no
 * single contact behind it the way a direct chat's peer does.
 */
export async function setConversationFavourite(
  actor: Actor,
  conversationId: string,
  isFavourite: boolean,
): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  const result = await query(
    `UPDATE conversation_participants SET is_favourite = $3 WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, actor.userId, isFavourite],
  );
  if (result.rowCount === 0) throw AppError.notFound('Conversation not found');
}

/**
 * Records a report against a group by writing an audit entry rather than a
 * bespoke table — this is exactly the "who did what to which resource" shape
 * audit logs already exist for (CLAUDE.md §28), and it gives an organisation
 * admin a real trail to review without inventing a parallel moderation
 * queue this project has no UI for yet.
 */
export async function reportGroup(actor: Actor, conversationId: string, reason: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);
  await assertGroup(conversationId);

  const trimmedReason = reason.trim();
  if (!trimmedReason) throw AppError.validation('Add a reason for the report');

  recordAuditDetached({
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: 'group.reported',
    resourceType: 'conversation',
    resourceId: conversationId,
    metadata: { reason: trimmedReason.slice(0, 1000) },
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

/** The other people in a conversation, for direct conversations always exactly one. */
async function otherParticipantIds(conversationId: string, userId: string): Promise<string[]> {
  const rows = await queryMany<{ user_id: string }>(
    `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id <> $2`,
    [conversationId, userId],
  );
  return rows.map((row) => row.user_id);
}

interface ParticipantWatermark {
  last_read_at: Date | null;
  last_delivered_at: Date | null;
}

/** The other participants' read/delivery watermarks — what a sent message's status is judged against. */
async function otherParticipantWatermarks(conversationId: string, userId: string): Promise<ParticipantWatermark[]> {
  return queryMany<ParticipantWatermark>(
    `SELECT last_read_at, last_delivered_at
       FROM conversation_participants
      WHERE conversation_id = $1 AND user_id <> $2`,
    [conversationId, userId],
  );
}

/**
 * A message is "read" once every other participant's `last_read_at` has
 * caught up to it, "delivered" once at least one has — matching a group
 * chat's usual all-vs-any tick semantics, though today's UI only ever has one
 * other participant. No watermark at all (a brand-new participant row) means
 * "sent" — the message has not been fetched yet.
 */
function computeMessageStatus(createdAt: Date, others: ParticipantWatermark[]): MessageDeliveryStatus {
  if (others.length === 0) return 'sent';
  if (others.every((other) => other.last_read_at && other.last_read_at >= createdAt)) return 'read';
  if (others.some((other) => other.last_delivered_at && other.last_delivered_at >= createdAt)) return 'delivered';
  return 'sent';
}

/**
 * Every precondition for putting new content into a conversation: the caller
 * is a member and a participant, and — for a direct conversation — nobody on
 * either side has blocked the other. Shared by `sendMessage` and every
 * attachment sender so they can never drift apart on what "allowed to
 * message" means.
 *
 * Blocking is a 1:1 concept and stays that way here: enforcing it pairwise
 * in a group would let any single blocked relationship between two members
 * silently stop the whole conversation for everyone, which is not what
 * either of them asked for.
 */
async function assertCanMessage(actor: Actor, conversationId: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);

  const conversation = await queryOne<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [
    conversationId,
  ]);
  if (conversation?.kind === 'group') return;

  const others = await otherParticipantIds(conversationId, actor.userId);
  for (const otherId of others) {
    if (await isBlockedBetween(actor.userId, otherId)) {
      throw AppError.permission('You cannot message this person while blocked');
    }
  }
}

/**
 * Turns stored attachments (object-storage key only) into API-facing ones
 * (a usable, time-limited URL). Resolved at read time rather than stored,
 * because the bucket is private and a stored URL would eventually expire
 * without anything to refresh it.
 */
async function resolveAttachments(stored: StoredAttachment[]): Promise<MessageAttachmentView[]> {
  if (!stored || stored.length === 0) return [];
  return Promise.all(
    stored.map(async (attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      durationSeconds: attachment.durationSeconds,
      url: await objectStorage.signedDownloadUrl(attachment.storageKey, { expiresInSeconds: 3600 }),
    })),
  );
}

/**
 * Deletes a conversation for the caller only, WhatsApp-style: their row in
 * `conversation_participants` is marked deleted so it drops out of their
 * list, but the conversation, its messages and the other participant's copy
 * are untouched.
 *
 * Two things happen, and they behave differently over time:
 * - `deleted_at` hides the conversation from the caller's list. A later
 *   message from either side clears it again (see `sendMessage`), so the
 *   thread reappears rather than staying hidden from someone actively being
 *   messaged.
 * - `history_cleared_at` is a permanent cutoff: `listMessages` and
 *   `listMedia` hide anything at or before it for this participant, and
 *   nothing clears it automatically. So when the thread reappears, the
 *   caller sees only what was sent after they deleted it — the other
 *   participant, who has no cutoff, keeps their full history.
 */
export async function deleteConversation(actor: Actor, conversationId: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  const result = await query(
    `UPDATE conversation_participants SET deleted_at = now(), history_cleared_at = now()
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, actor.userId],
  );
  if (result.rowCount === 0) throw AppError.notFound('Conversation not found');
}

/**
 * Clears the caller's message history without touching the conversation's
 * place in their list — the "Clear chat" action, as distinct from "Delete
 * chat" above. Only `history_cleared_at` moves; `deleted_at` is left alone,
 * so the conversation stays right where it was in the sidebar, just empty
 * until new messages arrive. The other participant's copy is unaffected.
 */
export async function clearConversationHistory(actor: Actor, conversationId: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  const result = await query(
    `UPDATE conversation_participants SET history_cleared_at = now()
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, actor.userId],
  );
  if (result.rowCount === 0) throw AppError.notFound('Conversation not found');
}

/**
 * Finds an existing direct conversation with another user, reviving it (but
 * not its cleared history — see `deleteConversation`) if the caller had
 * deleted their copy.
 *
 * "Start a conversation" calls this before offering a chat request: without
 * it, picking someone you already have a conversation with — just hidden
 * because you deleted it — hits `sendChatRequest`'s "you can already message
 * this person" conflict with no way back in, since the thread that would
 * explain that is exactly the one that is hidden.
 */
export async function findOrReviveDirectConversation(actor: Actor, otherUserId: string): Promise<string | null> {
  await requireMembership(actor.userId, actor.organizationId);

  const conversationId = await findDirectConversationId(actor.userId, otherUserId);
  if (!conversationId) return null;

  await query(
    `UPDATE conversation_participants SET deleted_at = NULL
      WHERE conversation_id = $1 AND user_id = $2 AND deleted_at IS NOT NULL`,
    [conversationId, actor.userId],
  );

  return conversationId;
}

export interface MediaItemView {
  id: string;
  messageId: string;
  conversationId: string;
  isMine: boolean;
  createdAt: string;
  name: string;
  url: string | null;
  mimeType: string | null;
  size: number | null;
}

/** Attachments shared in a conversation, newest first — the panel's media tab. */
export async function listMedia(actor: Actor, conversationId: string): Promise<MediaItemView[]> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);

  const rows = await queryMany<{
    id: string;
    conversation_id: string;
    sender_id: string | null;
    attachments: Array<Record<string, any>>;
    created_at: string;
  }>(
    `SELECT m.id, m.conversation_id, m.sender_id, m.attachments, m.created_at
       FROM messages m
       JOIN conversation_participants cp
         ON cp.conversation_id = m.conversation_id AND cp.user_id = $2
      WHERE m.conversation_id = $1
        AND m.deleted_at IS NULL
        AND NOT ($2 = ANY(m.deleted_for))
        AND jsonb_array_length(m.attachments) > 0
        AND (cp.history_cleared_at IS NULL OR m.created_at > cp.history_cleared_at)
      ORDER BY m.created_at DESC`,
    [conversationId, actor.userId],
  );

  const items: MediaItemView[] = [];
  for (const row of rows) {
    for (const [index, attachment] of row.attachments.entries()) {
      items.push({
        id: `${row.id}:${attachment.id ?? index}`,
        messageId: row.id,
        conversationId: row.conversation_id,
        isMine: row.sender_id === actor.userId,
        createdAt: new Date(row.created_at).toISOString(),
        name: attachment.name ?? 'Attachment',
        url: attachment.storageKey
          ? await objectStorage.signedDownloadUrl(attachment.storageKey, { expiresInSeconds: 3600 })
          : attachment.url ?? null,
        mimeType: attachment.mimeType ?? attachment.type ?? null,
        size: typeof attachment.size === 'number' ? attachment.size : null,
      });
    }
  }
  return items;
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
            m.attachments, m.reactions, m.mentions, m.is_edited, m.pinned_at, m.forwarded,
            m.deleted_at, m.created_at,
            coalesce(u.full_name, 'Removed user') AS sender_name
       FROM messages m
       JOIN conversation_participants cp
         ON cp.conversation_id = m.conversation_id AND cp.user_id = $4
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1
        -- A "deleted for everyone" message stays in the thread as a
        -- tombstone (body/attachments already cleared — see deleteMessage);
        -- only "deleted for me" actually removes it from this query.
        AND NOT ($4 = ANY(m.deleted_for))
        AND ($2::timestamptz IS NULL OR m.created_at < $2)
        -- A cleared history stays cleared even after the conversation
        -- reappears (see deleteConversation's doc comment).
        AND (cp.history_cleared_at IS NULL OR m.created_at > cp.history_cleared_at)
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [conversationId, options.before ?? null, limit, actor.userId],
  );

  // Fetching the thread is itself a delivery: the caller's client now has
  // these bytes, whether or not they go on to read them (see 0008).
  await query(
    `UPDATE conversation_participants SET last_delivered_at = now()
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, actor.userId],
  );

  const others = await otherParticipantWatermarks(conversationId, actor.userId);

  // Query is newest-first for the limit; the client wants oldest-first.
  return Promise.all(
    rows.reverse().map(async (row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      body: row.body,
      threadParentId: row.thread_parent_id,
      replyToId: row.reply_to_id,
      attachments: await resolveAttachments(row.attachments ?? []),
      reactions: row.reactions ?? {},
      mentions: row.mentions ?? [],
      isEdited: row.is_edited,
      isMine: row.sender_id === actor.userId,
      ...(row.sender_id === actor.userId
        ? { status: computeMessageStatus(new Date(row.created_at), others) }
        : {}),
      pinnedAt: row.pinned_at ? new Date(row.pinned_at).toISOString() : null,
      isForwarded: row.forwarded,
      isDeleted: row.deleted_at !== null,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  );
}

/**
 * Hydrates a single message by id into its API view — the shared tail end of
 * reacting, pinning, and forwarding, all of which mutate one row and then
 * need to hand the caller back the same shape `listMessages` produces.
 */
async function getMessageView(actor: Actor, messageId: string): Promise<MessageView> {
  const row = await queryOne(
    `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.thread_parent_id, m.reply_to_id,
            m.attachments, m.reactions, m.mentions, m.is_edited, m.pinned_at, m.forwarded,
            m.deleted_at, m.created_at,
            coalesce(u.full_name, 'Removed user') AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.id = $1`,
    [messageId],
  );
  if (!row) throw AppError.notFound('Message not found');

  const others = await otherParticipantWatermarks(row.conversation_id, actor.userId);

  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    body: row.body,
    threadParentId: row.thread_parent_id,
    replyToId: row.reply_to_id,
    attachments: await resolveAttachments(row.attachments ?? []),
    reactions: row.reactions ?? {},
    mentions: row.mentions ?? [],
    isEdited: row.is_edited,
    isMine: row.sender_id === actor.userId,
    ...(row.sender_id === actor.userId
      ? { status: computeMessageStatus(new Date(row.created_at), others) }
      : {}),
    pinnedAt: row.pinned_at ? new Date(row.pinned_at).toISOString() : null,
    isForwarded: row.forwarded,
    isDeleted: row.deleted_at !== null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function sendMessage(
  actor: Actor,
  conversationId: string,
  input: { body: string; replyToId?: string; threadParentId?: string; mentions?: string[] },
): Promise<MessageView> {
  await assertCanMessage(actor, conversationId);

  const body = input.body.trim();
  if (!body) throw AppError.validation('A message cannot be empty');

  const row = await withTransaction(async (tx) => {
    const inserted = await tx.query<MessageRow>(
      `INSERT INTO messages (conversation_id, organization_id, sender_id, body, reply_to_id, thread_parent_id, mentions)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, conversation_id, sender_id, body, thread_parent_id, reply_to_id,
                   attachments, reactions, mentions, is_edited, pinned_at, forwarded, deleted_at, created_at`,
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

    // A new message means the conversation is active again — for whichever
    // side had previously deleted it (see `deleteConversation`'s doc comment).
    await tx.query(
      `UPDATE conversation_participants SET deleted_at = NULL
        WHERE conversation_id = $1 AND deleted_at IS NOT NULL`,
      [conversationId],
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
    attachments: await resolveAttachments(row.attachments ?? []),
    reactions: row.reactions ?? {},
    mentions: row.mentions ?? [],
    isEdited: row.is_edited,
    isMine: true,
    // Freshly inserted: nobody else can have a watermark past `created_at` yet.
    status: 'sent',
    pinnedAt: null,
    isForwarded: false,
    isDeleted: false,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// Generous for chat images/short clips/documents without turning Messenger
// into a general file-transfer tool — that is Drive's job (CLAUDE.md §11).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

interface NewAttachmentInput {
  buffer: Buffer;
  mimeType: string;
  size: number;
  name: string;
  kind: 'voice' | 'image' | 'video' | 'file';
  durationSeconds?: number;
}

const ATTACHMENT_PREVIEW: Record<NewAttachmentInput['kind'], (name: string) => string> = {
  voice: () => '🎤 Voice message',
  image: () => '📷 Photo',
  video: () => '🎥 Video',
  file: (name) => `📎 ${name}`,
};

/**
 * The shared core behind every attachment-only message (voice notes,
 * documents, photos, videos): bytes go to object storage first (CLAUDE.md
 * §11), the message body stays empty, and the conversation preview gets a
 * kind-appropriate label since there is no text to show instead.
 */
async function sendAttachmentMessage(
  actor: Actor,
  conversationId: string,
  input: NewAttachmentInput,
): Promise<MessageView> {
  await assertCanMessage(actor, conversationId);

  if (input.size === 0) throw AppError.validation('The file was empty');
  if (input.size > MAX_ATTACHMENT_BYTES) {
    throw AppError.validation('Attachments are limited to 25 MB');
  }

  const messageId = randomUUID();
  const storageKey = objectKeys.chatAttachment(actor.organizationId, conversationId, messageId);

  // Bytes first: a failed write leaves no message pointing at a missing object.
  await objectStorage.put({
    key: storageKey,
    body: input.buffer,
    contentType: input.mimeType,
    contentLength: input.size,
  });

  const attachment: StoredAttachment = {
    id: messageId,
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType,
    size: input.size,
    storageKey,
    ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
  };

  const preview = ATTACHMENT_PREVIEW[input.kind](input.name).slice(0, 160);

  const row = await withTransaction(async (tx) => {
    const inserted = await tx.query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, organization_id, sender_id, body, attachments)
            VALUES ($1, $2, $3, $4, '', $5::jsonb)
         RETURNING id, conversation_id, sender_id, body, thread_parent_id, reply_to_id,
                   attachments, reactions, mentions, is_edited, pinned_at, forwarded, deleted_at, created_at`,
      [messageId, conversationId, actor.organizationId, actor.userId, JSON.stringify([attachment])],
    );

    const stored = inserted.rows[0];
    if (!stored) throw AppError.internal('Message could not be stored');

    await tx.query(
      `UPDATE conversations SET last_message_at = now(), last_message_preview = $2 WHERE id = $1`,
      [conversationId, preview],
    );
    await tx.query(
      `UPDATE conversation_participants SET last_read_at = now()
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, actor.userId],
    );
    await tx.query(
      `UPDATE conversation_participants SET deleted_at = NULL
        WHERE conversation_id = $1 AND deleted_at IS NOT NULL`,
      [conversationId],
    );

    await publishEvent(
      tx,
      'chat.message_sent',
      { organizationId: actor.organizationId, conversationId, messageId: stored.id, senderId: actor.userId },
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
    attachments: await resolveAttachments(row.attachments ?? []),
    reactions: row.reactions ?? {},
    mentions: row.mentions ?? [],
    isEdited: row.is_edited,
    isMine: true,
    status: 'sent',
    pinnedAt: null,
    isForwarded: false,
    isDeleted: false,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export interface VoiceMessageInput {
  buffer: Buffer;
  mimeType: string;
  size: number;
  durationSeconds?: number;
}

export async function sendVoiceMessage(
  actor: Actor,
  conversationId: string,
  input: VoiceMessageInput,
): Promise<MessageView> {
  return sendAttachmentMessage(actor, conversationId, { ...input, name: 'Voice message', kind: 'voice' });
}

export interface FileMessageInput {
  buffer: Buffer;
  mimeType: string;
  size: number;
  name: string;
}

/** Document, photo, video, or audio-file share — the "+" menu next to the composer. */
export async function sendFileMessage(
  actor: Actor,
  conversationId: string,
  input: FileMessageInput,
): Promise<MessageView> {
  const kind: NewAttachmentInput['kind'] = input.mimeType.startsWith('image/')
    ? 'image'
    : input.mimeType.startsWith('video/')
    ? 'video'
    : 'file';
  return sendAttachmentMessage(actor, conversationId, { ...input, kind });
}

export async function markConversationRead(actor: Actor, conversationId: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);
  await query(
    // Reading implies delivery, so both watermarks move together — a reader
    // can never appear "read but not delivered".
    `UPDATE conversation_participants SET last_read_at = now(), last_delivered_at = now()
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, actor.userId],
  );
}

export type DeleteMessageMode = 'me' | 'everyone';

/**
 * Deletes a message, WhatsApp-style, in one of two ways:
 *
 * - `'me'`: hides the message from the caller only. Any participant can do
 *   this to any message, including ones they didn't send — it never touches
 *   the row anyone else sees, it just adds the caller to `deleted_for`, which
 *   every listing query (`listMessages`, `listMedia`, `listLinks`,
 *   `listPinnedMessages`) excludes on their behalf.
 * - `'everyone'`: only the sender can do this. The message becomes a
 *   tombstone — `body` and `attachments` are cleared and `reactions` reset,
 *   so nothing it carried survives — but the row itself stays in the thread
 *   with `deleted_at` set, and every participant (including the sender)
 *   keeps seeing it, now rendered as "This message was deleted".
 *
 * Returns the hydrated message for `'everyone'`, so the caller's own client
 * can swap the tombstone in immediately instead of waiting for the next
 * poll; returns null for `'me'`, since that view only makes sense for other
 * participants, who did not just delete anything.
 */
export async function editMessage(actor: Actor, messageId: string, body: string): Promise<MessageView> {
  await requireMembership(actor.userId, actor.organizationId);

  const trimmed = body.trim();
  if (!trimmed) throw AppError.validation('A message cannot be empty');

  const existing = await queryOne<{
    sender_id: string | null;
    deleted_at: string | null;
    attachments: StoredAttachment[];
    created_at: string;
  }>(`SELECT sender_id, deleted_at, attachments, created_at FROM messages WHERE id = $1`, [messageId]);

  if (!existing || existing.sender_id !== actor.userId) {
    throw AppError.notFound('Message not found, or it is not yours to edit');
  }
  if (existing.deleted_at) throw AppError.validation('This message was deleted and cannot be edited');
  // Attachment messages have no caption UI — the view always renders the
  // attachment in place of the body, so an edited body would silently vanish
  // behind it. Editing is text-messages-only until that changes.
  if ((existing.attachments ?? []).length > 0) {
    throw AppError.validation('Only text messages can be edited');
  }
  // Mirrors the UI's edit window (EDIT_WINDOW_MS in the messages app) so the
  // rule holds even if someone calls this endpoint directly.
  if (Date.now() - new Date(existing.created_at).getTime() > EDIT_WINDOW_MS) {
    throw AppError.validation('This message can no longer be edited');
  }

  await query(`UPDATE messages SET body = $2, is_edited = true, edited_at = now() WHERE id = $1`, [
    messageId,
    trimmed.slice(0, 8000),
  ]);

  return getMessageView(actor, messageId);
}
export async function deleteMessage(
  actor: Actor,
  messageId: string,
  mode: DeleteMessageMode,
): Promise<MessageView | null> {
  await requireMembership(actor.userId, actor.organizationId);

  if (mode === 'me') {
    const message = await queryOne<{ conversation_id: string }>(`SELECT conversation_id FROM messages WHERE id = $1`, [
      messageId,
    ]);
    if (!message) throw AppError.notFound('Message not found');
    await assertParticipant(message.conversation_id, actor.userId);

    await query(
      `UPDATE messages SET deleted_for = array_append(deleted_for, $2)
        WHERE id = $1 AND NOT ($2 = ANY(deleted_for))`,
      [messageId, actor.userId],
    );
    return null;
  }

  const result = await query(
    `UPDATE messages
        SET deleted_at = now(), body = '', attachments = '[]'::jsonb, reactions = '{}'::jsonb, pinned_at = NULL
      WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL`,
    [messageId, actor.userId],
  );
  if (result.rowCount === 0) {
    throw AppError.notFound('Message not found, or it is not yours to delete for everyone');
  }
  return getMessageView(actor, messageId);
}

/**
 * Toggles the caller's reaction on a message to one emoji, WhatsApp-style: a
 * user has at most one reaction per message, so setting a new one replaces
 * whatever they had before, and tapping the same emoji again clears it. The
 * row is locked for the read-modify-write so two rapid taps from the same
 * user can't race each other into an inconsistent `reactions` map.
 */
export async function toggleMessageReaction(actor: Actor, messageId: string, emoji: string): Promise<MessageView> {
  await requireMembership(actor.userId, actor.organizationId);

  const trimmedEmoji = emoji.trim();
  if (!trimmedEmoji) throw AppError.validation('Pick an emoji to react with');
  if (trimmedEmoji.length > 16) throw AppError.validation('That is not a single emoji');

  await withTransaction(async (tx) => {
    const existing = await tx.query<{ conversation_id: string; reactions: Record<string, string[]>; deleted_at: string | null }>(
      `SELECT conversation_id, reactions, deleted_at FROM messages WHERE id = $1 FOR UPDATE`,
      [messageId],
    );
    const row = existing.rows[0];
    if (!row || row.deleted_at) throw AppError.notFound('Message not found');
    await assertParticipant(row.conversation_id, actor.userId);

    const alreadyHadThis = (row.reactions?.[trimmedEmoji] ?? []).includes(actor.userId);

    const reactions: Record<string, string[]> = {};
    for (const [emojiKey, userIds] of Object.entries(row.reactions ?? {})) {
      const withoutActor = userIds.filter((id) => id !== actor.userId);
      if (withoutActor.length > 0) reactions[emojiKey] = withoutActor;
    }
    if (!alreadyHadThis) {
      reactions[trimmedEmoji] = [...(reactions[trimmedEmoji] ?? []), actor.userId];
    }

    await tx.query(`UPDATE messages SET reactions = $2::jsonb WHERE id = $1`, [messageId, JSON.stringify(reactions)]);
  });

  return getMessageView(actor, messageId);
}

/**
 * Pins or unpins a message within its conversation. Any participant can pin —
 * unlike the group-editing actions gated to admins (`assertGroupAdmin`), a
 * pin only surfaces something already visible to everyone in the thread, it
 * does not change the group's identity the way its name or membership does.
 */
export async function setMessagePinned(actor: Actor, messageId: string, pinned: boolean): Promise<MessageView> {
  await requireMembership(actor.userId, actor.organizationId);

  const message = await queryOne<{ conversation_id: string }>(
    `SELECT conversation_id FROM messages WHERE id = $1 AND deleted_at IS NULL`,
    [messageId],
  );
  if (!message) throw AppError.notFound('Message not found');
  await assertParticipant(message.conversation_id, actor.userId);

  await query(`UPDATE messages SET pinned_at = $2 WHERE id = $1`, [messageId, pinned ? new Date() : null]);
  return getMessageView(actor, messageId);
}

/** Pinned messages in a conversation, most recently pinned first — the chat header's pin banner. */
export async function listPinnedMessages(actor: Actor, conversationId: string): Promise<MessageView[]> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);

  const rows = await queryMany<{ id: string }>(
    `SELECT m.id
       FROM messages m
       JOIN conversation_participants cp
         ON cp.conversation_id = m.conversation_id AND cp.user_id = $2
      WHERE m.conversation_id = $1
        AND m.deleted_at IS NULL
        AND NOT ($2 = ANY(m.deleted_for))
        AND m.pinned_at IS NOT NULL
        AND (cp.history_cleared_at IS NULL OR m.created_at > cp.history_cleared_at)
      ORDER BY m.pinned_at DESC`,
    [conversationId, actor.userId],
  );

  return Promise.all(rows.map((row) => getMessageView(actor, row.id)));
}

export interface ForwardResult {
  conversationId: string;
  message: MessageView;
}

/**
 * Forwards a message's content (text and/or attachments) into other
 * conversations as brand-new messages. Attachments are copied by reference —
 * the same `storageKey` is reused rather than re-uploading the bytes, since
 * the underlying object is immutable and every recipient already has
 * permission to read it once it's attached to a message in their own
 * conversation. A forwarded message starts fresh: no `replyToId` or
 * `threadParentId` carries over, since those pointed at context that only
 * existed in the source conversation.
 */
export async function forwardMessage(
  actor: Actor,
  messageId: string,
  targetConversationIds: string[],
): Promise<ForwardResult[]> {
  await requireMembership(actor.userId, actor.organizationId);

  const source = await queryOne<{ conversation_id: string; body: string; attachments: StoredAttachment[] }>(
    `SELECT conversation_id, body, attachments FROM messages WHERE id = $1 AND deleted_at IS NULL`,
    [messageId],
  );
  if (!source) throw AppError.notFound('Message not found');
  await assertParticipant(source.conversation_id, actor.userId);

  const targets = Array.from(new Set(targetConversationIds));
  if (targets.length === 0) throw AppError.validation('Pick at least one conversation to forward to');
  if (targets.length > 20) throw AppError.validation('You can forward to at most 20 conversations at once');

  const attachments = source.attachments ?? [];
  const firstAttachment = attachments[0];
  const preview = firstAttachment
    ? ATTACHMENT_PREVIEW[firstAttachment.kind](firstAttachment.name).slice(0, 160)
    : source.body.slice(0, 160);

  const results: ForwardResult[] = [];
  for (const conversationId of targets) {
    await assertCanMessage(actor, conversationId);

    const row = await withTransaction(async (tx) => {
      const inserted = await tx.query<MessageRow>(
        `INSERT INTO messages (conversation_id, organization_id, sender_id, body, attachments, forwarded)
              VALUES ($1, $2, $3, $4, $5::jsonb, true)
           RETURNING id, conversation_id, sender_id, body, thread_parent_id, reply_to_id,
                     attachments, reactions, mentions, is_edited, pinned_at, forwarded, deleted_at, created_at`,
        [conversationId, actor.organizationId, actor.userId, source.body, JSON.stringify(attachments)],
      );
      const stored = inserted.rows[0];
      if (!stored) throw AppError.internal('Message could not be forwarded');

      await tx.query(
        `UPDATE conversations SET last_message_at = now(), last_message_preview = $2 WHERE id = $1`,
        [conversationId, preview],
      );
      await tx.query(
        `UPDATE conversation_participants SET last_read_at = now()
          WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, actor.userId],
      );
      await tx.query(
        `UPDATE conversation_participants SET deleted_at = NULL
          WHERE conversation_id = $1 AND deleted_at IS NOT NULL`,
        [conversationId],
      );

      await publishEvent(
        tx,
        'chat.message_sent',
        { organizationId: actor.organizationId, conversationId, messageId: stored.id, senderId: actor.userId },
        { organizationId: actor.organizationId, actorId: actor.userId },
      );

      return stored;
    });

    results.push({ conversationId, message: await getMessageView(actor, row.id) });
  }

  return results;
}

export interface LinkItemView {
  id: string;
  messageId: string;
  conversationId: string;
  isMine: boolean;
  createdAt: string;
  url: string;
  domain: string;
  snippet: string;
}

const URL_PATTERN = /https?:\/\/[^\s]+/gi;

/** Links shared in a conversation, newest first — the panel's Links tab, alongside Media and Docs. */
export async function listLinks(actor: Actor, conversationId: string): Promise<LinkItemView[]> {
  await requireMembership(actor.userId, actor.organizationId);
  await assertParticipant(conversationId, actor.userId);

  const rows = await queryMany<{ id: string; sender_id: string | null; body: string; created_at: string }>(
    `SELECT m.id, m.sender_id, m.body, m.created_at
       FROM messages m
       JOIN conversation_participants cp
         ON cp.conversation_id = m.conversation_id AND cp.user_id = $2
      WHERE m.conversation_id = $1
        AND m.deleted_at IS NULL
        AND NOT ($2 = ANY(m.deleted_for))
        AND m.body ~* 'https?://'
        AND (cp.history_cleared_at IS NULL OR m.created_at > cp.history_cleared_at)
      ORDER BY m.created_at DESC`,
    [conversationId, actor.userId],
  );

  const items: LinkItemView[] = [];
  for (const row of rows) {
    const matches = row.body.match(URL_PATTERN) ?? [];
    for (const url of matches) {
      let domain = url;
      try {
        domain = new URL(url).hostname;
      } catch {
        // Not a parseable URL despite matching the pattern; fall back to showing it as-is.
      }
      items.push({
        id: `${row.id}:${items.length}`,
        messageId: row.id,
        conversationId,
        isMine: row.sender_id === actor.userId,
        createdAt: new Date(row.created_at).toISOString(),
        url,
        domain,
        snippet: row.body.slice(0, 200),
      });
    }
  }
  return items;
}
