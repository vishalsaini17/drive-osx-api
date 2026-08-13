import { AppError } from '../../platform/errors/app-error.js';
import { requireMembership } from '../../platform/authorization/access-control.js';
import { query, queryMany, queryOne } from '../../infrastructure/database/pool.js';

/**
 * Contacts and presence.
 *
 * A contact belongs to one owner — it is a personal address book entry, not a
 * shared organization directory. Most entries point at a platform user and are
 * created automatically when a chat request is accepted (see
 * `messaging.service`); the rest are external people typed in by hand.
 *
 * Presence is deliberately derived rather than trusted: a browser that closes
 * without a clean sign-off leaves `status = 'online'` behind forever, so a
 * stale heartbeat reads as offline no matter what the stored row says.
 */

export interface Actor {
  userId: string;
  organizationId: string;
}

export type PresenceStatus = 'online' | 'away' | 'busy' | 'dnd' | 'offline';

/**
 * How long a heartbeat vouches for a user. The client refreshes well inside
 * this window; anything older is treated as a browser that went away.
 */
export const PRESENCE_TTL_SECONDS = 120;

export interface ContactView {
  id: string;
  userId: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  jobTitle: string | null;
  notes: string | null;
  address: string | null;
  website: string | null;
  /** `YYYY-MM-DD`; a birthday has no time of day and must not shift zone. */
  birthday: string | null;
  department: string | null;
  team: string | null;
  labels: string[];
  isFavourite: boolean;
  source: 'manual' | 'chat_request' | 'import';
  /** Null for external contacts, who have no account and so no presence. */
  presence: PresenceStatus | null;
  statusText: string;
  statusEmoji: string;
  lastSeenAt: string | null;
  username: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

/**
 * Resolves the presence a *viewer* should see.
 *
 * Exported because this is the rule most likely to be got wrong twice: it must
 * hold for the contact list, the messenger sidebar and any future presence
 * surface, and it is pure, so it can be tested without a database.
 */
export function effectivePresence(input: {
  status: string | null;
  lastSeenAt: Date | string | null;
  now?: Date;
}): PresenceStatus {
  if (!input.status || input.status === 'offline') return 'offline';
  if (!input.lastSeenAt) return 'offline';

  const seen = input.lastSeenAt instanceof Date ? input.lastSeenAt : new Date(input.lastSeenAt);
  if (Number.isNaN(seen.getTime())) return 'offline';

  const now = input.now ?? new Date();
  const ageSeconds = (now.getTime() - seen.getTime()) / 1000;

  // A future timestamp means clock skew, not presence from the future.
  if (ageSeconds > PRESENCE_TTL_SECONDS) return 'offline';

  return input.status as PresenceStatus;
}

function mapContact(row: Record<string, any>): ContactView {
  const isPlatformUser = Boolean(row.contact_user_id);

  return {
    id: row.id,
    userId: row.contact_user_id ?? null,
    displayName: row.display_name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    company: row.company ?? null,
    jobTitle: row.job_title ?? null,
    notes: row.notes ?? null,
    address: row.address ?? null,
    website: row.website ?? null,
    // `date` comes back as a Date in UTC; formatting it as ISO and slicing
    // keeps the calendar day the user entered.
    birthday: row.birthday ? new Date(row.birthday).toISOString().slice(0, 10) : null,
    department: row.department ?? null,
    team: row.team ?? null,
    labels: row.labels ?? [],
    isFavourite: row.is_favourite,
    source: row.source,
    presence: isPlatformUser
      ? effectivePresence({ status: row.status, lastSeenAt: row.last_seen_at })
      : null,
    statusText: row.status_text ?? '',
    statusEmoji: row.status_emoji ?? '',
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    username: row.username ?? null,
    avatarUrl: row.avatar_url ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const CONTACT_SELECT = `
  SELECT c.id, c.contact_user_id, c.display_name, c.email, c.phone, c.company,
         c.job_title, c.notes, c.is_favourite, c.source, c.created_at,
         c.address, c.website, c.birthday, c.department, c.team, c.labels,
         u.username, u.avatar_url,
         p.status, p.status_text, p.status_emoji, p.last_seen_at
    FROM contacts c
    LEFT JOIN users u ON u.id = c.contact_user_id
    LEFT JOIN user_presence p ON p.user_id = c.contact_user_id
`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listContacts(
  actor: Actor,
  options: { search?: string; favouritesOnly?: boolean } = {},
): Promise<ContactView[]> {
  await requireMembership(actor.userId, actor.organizationId);

  const search = options.search?.trim();

  const rows = await queryMany(
    `${CONTACT_SELECT}
      WHERE c.owner_id = $1
        AND ($2::boolean IS NOT TRUE OR c.is_favourite = true)
        AND (
          $3::text IS NULL
          OR c.display_name ILIKE $3
          OR c.email ILIKE $3
          OR u.username ILIKE $3
          OR c.company ILIKE $3
        )
      ORDER BY c.is_favourite DESC, c.display_name`,
    [actor.userId, options.favouritesOnly ?? false, search ? `%${search}%` : null],
  );

  return rows.map(mapContact);
}

export async function getContact(actor: Actor, contactId: string): Promise<ContactView> {
  await requireMembership(actor.userId, actor.organizationId);

  const row = await queryOne(`${CONTACT_SELECT} WHERE c.id = $1 AND c.owner_id = $2`, [
    contactId,
    actor.userId,
  ]);
  // "Not found" rather than "forbidden": another owner's contact should not be
  // distinguishable from one that does not exist.
  if (!row) throw AppError.notFound('Contact not found');

  return mapContact(row);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface ContactInput {
  displayName?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  notes?: string | null;
  address?: string | null;
  website?: string | null;
  birthday?: string | null;
  department?: string | null;
  team?: string | null;
  labels?: string[];
  isFavourite?: boolean;
  /** Set to link this entry to a platform user (e.g. "save to contacts"). */
  contactUserId?: string | null;
}

export async function createContact(actor: Actor, input: ContactInput): Promise<ContactView> {
  await requireMembership(actor.userId, actor.organizationId);

  if (input.contactUserId) {
    if (input.contactUserId === actor.userId) {
      throw AppError.validation('You cannot add yourself as a contact');
    }

    const target = await queryOne<{ id: string; full_name: string; email: string }>(
      `SELECT id, full_name, email FROM users WHERE id = $1 AND status = 'active'`,
      [input.contactUserId],
    );
    if (!target) throw AppError.notFound('That user was not found');

    // Saving someone already saved is a no-op, not an error — the caller's
    // intent ("have this person in my contacts") is already satisfied.
    const existing = await queryOne(
      `${CONTACT_SELECT} WHERE c.owner_id = $1 AND c.contact_user_id = $2`,
      [actor.userId, input.contactUserId],
    );
    if (existing) return mapContact(existing);

    const created = await queryOne<{ id: string }>(
      `INSERT INTO contacts (organization_id, owner_id, contact_user_id, display_name, email, source)
            VALUES ($1, $2, $3, $4, $5, 'manual')
         RETURNING id`,
      [
        actor.organizationId,
        actor.userId,
        input.contactUserId,
        input.displayName?.trim() || target.full_name,
        input.email ?? target.email,
      ],
    );
    if (!created) throw AppError.internal('Contact could not be created');

    return getContact(actor, created.id);
  }

  const displayName = input.displayName?.trim();
  if (!displayName) throw AppError.validation('A contact needs a name');

  const created = await queryOne<{ id: string }>(
    `INSERT INTO contacts (organization_id, owner_id, display_name, email, phone, company,
                           job_title, notes, is_favourite, address, website, birthday,
                           department, team, labels, source)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'manual')
       RETURNING id`,
    [
      actor.organizationId,
      actor.userId,
      displayName,
      input.email ?? null,
      input.phone ?? null,
      input.company ?? null,
      input.jobTitle ?? null,
      input.notes ?? null,
      input.isFavourite ?? false,
      input.address ?? null,
      input.website ?? null,
      // An empty birthday must become NULL, not '' — `date` rejects the latter.
      input.birthday || null,
      input.department ?? null,
      input.team ?? null,
      input.labels ?? [],
    ],
  );
  if (!created) throw AppError.internal('Contact could not be created');

  return getContact(actor, created.id);
}

/** Columns a caller may change, mapped to their database names. */
const UPDATABLE: Record<string, string> = {
  displayName: 'display_name',
  email: 'email',
  phone: 'phone',
  company: 'company',
  jobTitle: 'job_title',
  notes: 'notes',
  address: 'address',
  website: 'website',
  birthday: 'birthday',
  department: 'department',
  team: 'team',
  labels: 'labels',
  isFavourite: 'is_favourite',
};

export async function updateContact(
  actor: Actor,
  contactId: string,
  patch: ContactInput,
): Promise<ContactView> {
  await requireMembership(actor.userId, actor.organizationId);

  const assignments: string[] = [];
  const values: unknown[] = [contactId, actor.userId];

  for (const [key, value] of Object.entries(patch)) {
    const column = UPDATABLE[key];
    if (!column || value === undefined) continue;

    const trimmed = typeof value === 'string' ? value.trim() : value;
    // Clearing a date field sends '', which `date` cannot parse — store NULL.
    values.push(key === 'birthday' && trimmed === '' ? null : trimmed);
    assignments.push(`${column} = $${values.length}`);
  }

  if (assignments.length === 0) return getContact(actor, contactId);

  const result = await query(
    `UPDATE contacts SET ${assignments.join(', ')}, updated_at = now()
      WHERE id = $1 AND owner_id = $2`,
    values,
  );
  if (result.rowCount === 0) throw AppError.notFound('Contact not found');

  return getContact(actor, contactId);
}

export async function deleteContact(actor: Actor, contactId: string): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);

  const result = await query(`DELETE FROM contacts WHERE id = $1 AND owner_id = $2`, [
    contactId,
    actor.userId,
  ]);
  if (result.rowCount === 0) throw AppError.notFound('Contact not found');
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export interface PresenceView {
  userId: string;
  status: PresenceStatus;
  statusText: string;
  statusEmoji: string;
  lastSeenAt: string | null;
}

/**
 * Records that the caller is still here. The client calls this periodically;
 * `effectivePresence` decays anyone who stops.
 */
export async function heartbeat(
  actor: Actor,
  input: { status?: PresenceStatus; statusText?: string; statusEmoji?: string } = {},
): Promise<PresenceView> {
  await requireMembership(actor.userId, actor.organizationId);

  const row = await queryOne<Record<string, any>>(
    `INSERT INTO user_presence (user_id, status, status_text, status_emoji, last_seen_at, updated_at)
          VALUES ($1, coalesce($2, 'online'), coalesce($3, ''), coalesce($4, ''), now(), now())
     ON CONFLICT (user_id) DO UPDATE
            SET status       = coalesce($2, user_presence.status),
                status_text  = coalesce($3, user_presence.status_text),
                status_emoji = coalesce($4, user_presence.status_emoji),
                last_seen_at = now(),
                updated_at   = now()
       RETURNING user_id, status, status_text, status_emoji, last_seen_at`,
    [actor.userId, input.status ?? null, input.statusText ?? null, input.statusEmoji ?? null],
  );
  if (!row) throw AppError.internal('Presence could not be recorded');

  return {
    userId: row.user_id,
    status: row.status,
    statusText: row.status_text,
    statusEmoji: row.status_emoji,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  };
}

/** Marks the caller offline immediately, for a deliberate sign-off. */
export async function goOffline(actor: Actor): Promise<void> {
  await requireMembership(actor.userId, actor.organizationId);
  await query(
    `INSERT INTO user_presence (user_id, status, last_seen_at, updated_at)
          VALUES ($1, 'offline', now(), now())
     ON CONFLICT (user_id) DO UPDATE
            SET status = 'offline', last_seen_at = now(), updated_at = now()`,
    [actor.userId],
  );
}

/**
 * Presence for a specific set of users. Bounded by the caller's list rather
 * than returning everyone, so this cannot be used to sweep the platform.
 */
export async function presenceFor(actor: Actor, userIds: string[]): Promise<PresenceView[]> {
  await requireMembership(actor.userId, actor.organizationId);
  if (userIds.length === 0) return [];

  const rows = await queryMany<Record<string, any>>(
    `SELECT user_id, status, status_text, status_emoji, last_seen_at
       FROM user_presence
      WHERE user_id = ANY($1::uuid[])`,
    [userIds],
  );

  return rows.map((row) => ({
    userId: row.user_id,
    status: effectivePresence({ status: row.status, lastSeenAt: row.last_seen_at }),
    statusText: row.status_text ?? '',
    statusEmoji: row.status_emoji ?? '',
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  }));
}
