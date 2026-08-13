import { randomInt } from 'node:crypto';
import { AppError } from '../../platform/errors/app-error.js';
import { publishEvent } from '../../platform/events/event-bus.js';
import { requireMembership } from '../../platform/authorization/access-control.js';
import { query, queryMany, queryOne, withTransaction } from '../../infrastructure/database/pool.js';
import { findUserById } from '../identity/identity.repository.js';

export interface MeetingParticipantView {
  id: string;
  userId: string | null;
  name: string;
  role: 'host' | 'cohost' | 'participant';
  isMuted: boolean;
  isVideoOn: boolean;
  joinedAt: string;
  leftAt: string | null;
}

export interface MeetingMessageView {
  id: string;
  sender: string;
  senderId: string | null;
  text: string;
  time: string;
  createdAt: string;
}

export interface MeetingView {
  id: string;
  _id: string;
  organizationId: string;
  hostId: string;
  meetingCode: string;
  title: string;
  description: string;
  status: 'scheduled' | 'active' | 'ended' | 'cancelled';
  startTime: string;
  endTime: string | null;
  hasPasscode: boolean;
  waitingRoomEnabled: boolean;
  allowScreenShare: boolean;
  allowChat: boolean;
  allowUnmute: boolean;
  allowRecording: boolean;
  isLocked: boolean;
  participants: MeetingParticipantView[];
  chatMessages: MeetingMessageView[];
}

interface MeetingRow {
  id: string;
  organization_id: string;
  host_id: string;
  code: string;
  title: string;
  description: string;
  status: MeetingView['status'];
  start_time: Date;
  end_time: Date | null;
  passcode: string | null;
  waiting_room_enabled: boolean;
  allow_screen_share: boolean;
  allow_chat: boolean;
  allow_unmute: boolean;
  allow_recording: boolean;
  is_locked: boolean;
}

const MEETING_COLUMNS = `
  id, organization_id, host_id, code, title, description, status, start_time, end_time,
  passcode, waiting_room_enabled, allow_screen_share, allow_chat, allow_unmute, allow_recording, is_locked
`;

/** The passcode is never returned — only whether one is required. */
function toMeetingView(
  row: MeetingRow,
  participants: MeetingParticipantView[] = [],
  chatMessages: MeetingMessageView[] = [],
): MeetingView {
  return {
    id: row.id,
    _id: row.id,
    organizationId: row.organization_id,
    hostId: row.host_id,
    meetingCode: row.code,
    title: row.title,
    description: row.description,
    status: row.status,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time ? row.end_time.toISOString() : null,
    hasPasscode: Boolean(row.passcode),
    waitingRoomEnabled: row.waiting_room_enabled,
    allowScreenShare: row.allow_screen_share,
    allowChat: row.allow_chat,
    allowUnmute: row.allow_unmute,
    allowRecording: row.allow_recording,
    isLocked: row.is_locked,
    participants,
    chatMessages,
  };
}

function generateMeetingCode(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz';
  const segment = (length: number) =>
    Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${segment(3)}-${segment(4)}-${segment(3)}`;
}

export interface Actor {
  userId: string;
  organizationId: string;
}

async function loadParticipants(meetingId: string): Promise<MeetingParticipantView[]> {
  return queryMany<MeetingParticipantView>(
    `SELECT id,
            user_id      AS "userId",
            display_name AS name,
            role,
            is_muted     AS "isMuted",
            is_video_on  AS "isVideoOn",
            joined_at    AS "joinedAt",
            left_at      AS "leftAt"
       FROM meeting_participants
      WHERE meeting_id = $1 AND left_at IS NULL
      ORDER BY joined_at`,
    [meetingId],
  );
}

async function loadMessages(meetingId: string, limit = 200): Promise<MeetingMessageView[]> {
  const rows = await queryMany<{
    id: string;
    sender_name: string;
    sender_id: string | null;
    body: string;
    created_at: Date;
  }>(
    `SELECT id, sender_name, sender_id, body, created_at
       FROM meeting_messages
      WHERE meeting_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [meetingId, limit],
  );

  return rows.reverse().map((row) => ({
    id: row.id,
    sender: row.sender_name,
    senderId: row.sender_id,
    text: row.body,
    time: row.created_at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    createdAt: row.created_at.toISOString(),
  }));
}

async function loadMeeting(meetingId: string): Promise<MeetingRow> {
  const row = await queryOne<MeetingRow>(`SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = $1`, [meetingId]);
  if (!row) throw AppError.notFound('Meeting not found');
  return row;
}

/** Anyone in the workspace may see a meeting; only the host controls it. */
async function assertCanView(actor: Actor, meeting: MeetingRow): Promise<void> {
  await requireMembership(actor.userId, meeting.organization_id);
}

export interface CreateMeetingInput {
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  passcode?: string;
  waitingRoomEnabled?: boolean;
  allowScreenShare?: boolean;
  allowChat?: boolean;
  allowUnmute?: boolean;
  allowRecording?: boolean;
}

export async function createMeeting(actor: Actor, input: CreateMeetingInput): Promise<MeetingView> {
  const host = await findUserById(actor.userId);
  if (!host) throw AppError.notFound('User not found');

  const row = await withTransaction(async (tx) => {
    const { rows } = await tx.query<MeetingRow>(
      `INSERT INTO meetings (organization_id, host_id, code, title, description, status, start_time, end_time,
                             passcode, waiting_room_enabled, allow_screen_share, allow_chat, allow_unmute, allow_recording)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${MEETING_COLUMNS}`,
      [
        actor.organizationId,
        actor.userId,
        generateMeetingCode(),
        input.title?.trim() || 'New Meeting',
        input.description?.trim() ?? '',
        input.startTime ? new Date(input.startTime) : new Date(),
        input.endTime ? new Date(input.endTime) : null,
        input.passcode?.trim() || null,
        input.waitingRoomEnabled ?? true,
        input.allowScreenShare ?? true,
        input.allowChat ?? true,
        input.allowUnmute ?? true,
        input.allowRecording ?? true,
      ],
    );

    const meeting = rows[0]!;

    await tx.query(
      `INSERT INTO meeting_participants (meeting_id, user_id, display_name, role)
       VALUES ($1, $2, $3, 'host')`,
      [meeting.id, actor.userId, host.full_name || host.username],
    );

    await publishEvent(
      tx,
      'meeting.created',
      { organizationId: actor.organizationId, meetingId: meeting.id, hostId: actor.userId },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );

    return meeting;
  });

  return toMeetingView(row, await loadParticipants(row.id));
}

export async function getMeeting(actor: Actor, meetingId: string): Promise<MeetingView> {
  const meeting = await loadMeeting(meetingId);
  await assertCanView(actor, meeting);
  return toMeetingView(meeting, await loadParticipants(meetingId), await loadMessages(meetingId));
}

/**
 * Meetings the caller hosts or takes part in, newest first.
 *
 * Paginated rather than unbounded: a long-lived account accumulates meetings
 * indefinitely, and the collection endpoint should not grow without limit
 * (CLAUDE.md §42).
 */
export async function listMeetings(
  actor: Actor,
  options: { status?: 'scheduled' | 'active' | 'ended' | 'cancelled'; limit?: number; offset?: number } = {},
): Promise<MeetingView[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const rows = await queryMany<MeetingRow>(
    `SELECT DISTINCT ${MEETING_COLUMNS.split(',')
      .map((column) => `m.${column.trim()}`)
      .join(', ')}
       FROM meetings m
       LEFT JOIN meeting_participants p ON p.meeting_id = m.id
      WHERE m.organization_id = $1
        AND (m.host_id = $2 OR p.user_id = $2)
        AND ($3::text IS NULL OR m.status = $3)
      ORDER BY m.start_time DESC
      LIMIT $4 OFFSET $5`,
    [actor.organizationId, actor.userId, options.status ?? null, limit, offset],
  );

  return Promise.all(rows.map(async (row) => toMeetingView(row, await loadParticipants(row.id))));
}

export async function listTodayMeetings(actor: Actor): Promise<MeetingView[]> {
  const rows = await queryMany<MeetingRow>(
    `SELECT DISTINCT ${MEETING_COLUMNS.split(',')
      .map((column) => `m.${column.trim()}`)
      .join(', ')}
       FROM meetings m
       LEFT JOIN meeting_participants p ON p.meeting_id = m.id
      WHERE m.organization_id = $1
        AND (m.host_id = $2 OR p.user_id = $2)
        AND m.start_time >= date_trunc('day', now())
        AND m.start_time < date_trunc('day', now()) + interval '1 day'
        AND m.status IN ('scheduled', 'active')
      ORDER BY m.start_time`,
    [actor.organizationId, actor.userId],
  );

  return Promise.all(rows.map(async (row) => toMeetingView(row, await loadParticipants(row.id))));
}

export async function startMeeting(actor: Actor, meetingId: string): Promise<MeetingView> {
  const meeting = await loadMeeting(meetingId);
  await assertCanView(actor, meeting);

  if (meeting.host_id !== actor.userId) {
    throw AppError.permission('Only the host can start this meeting');
  }
  if (meeting.status === 'ended') throw AppError.validation('This meeting has already ended');
  if (meeting.status === 'cancelled') throw AppError.validation('This meeting was cancelled');

  const row = await queryOne<MeetingRow>(
    `UPDATE meetings SET status = 'active', start_time = now() WHERE id = $1 RETURNING ${MEETING_COLUMNS}`,
    [meetingId],
  );

  return toMeetingView(row!, await loadParticipants(meetingId));
}

export async function joinMeeting(actor: Actor, meetingId: string, passcode?: string): Promise<MeetingView> {
  const meeting = await loadMeeting(meetingId);
  await assertCanView(actor, meeting);

  if (meeting.status === 'ended') throw AppError.validation('This meeting has already ended');
  if (meeting.status === 'cancelled') throw AppError.validation('This meeting was cancelled');
  if (meeting.is_locked && meeting.host_id !== actor.userId) {
    throw AppError.permission('The host has locked this meeting');
  }
  if (meeting.passcode && meeting.passcode !== passcode && meeting.host_id !== actor.userId) {
    throw AppError.permission('Incorrect meeting passcode');
  }

  const user = await findUserById(actor.userId);
  if (!user) throw AppError.notFound('User not found');

  // Re-joining after a dropped connection must not create a duplicate row.
  await query(
    `INSERT INTO meeting_participants (meeting_id, user_id, display_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (meeting_id, user_id) WHERE left_at IS NULL AND user_id IS NOT NULL
     DO UPDATE SET joined_at = now()`,
    [meetingId, actor.userId, user.full_name || user.username, meeting.host_id === actor.userId ? 'host' : 'participant'],
  );

  return toMeetingView(meeting, await loadParticipants(meetingId), await loadMessages(meetingId));
}

export async function leaveMeeting(actor: Actor, meetingId: string): Promise<{ message: string; ended: boolean }> {
  const meeting = await loadMeeting(meetingId);

  await query(
    'UPDATE meeting_participants SET left_at = now() WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL',
    [meetingId, actor.userId],
  );

  const remaining = await loadParticipants(meetingId);

  // The last participant leaving ends the meeting.
  if (remaining.length === 0 && meeting.status === 'active') {
    await endMeetingInternal(meetingId, meeting.organization_id, actor.userId);
    return { message: 'You left the meeting. It has now ended.', ended: true };
  }

  return { message: 'You left the meeting', ended: false };
}

async function endMeetingInternal(meetingId: string, organizationId: string, actorId: string): Promise<MeetingRow> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<MeetingRow>(
      `UPDATE meetings SET status = 'ended', end_time = now() WHERE id = $1 RETURNING ${MEETING_COLUMNS}`,
      [meetingId],
    );
    await tx.query('UPDATE meeting_participants SET left_at = now() WHERE meeting_id = $1 AND left_at IS NULL', [
      meetingId,
    ]);
    await publishEvent(tx, 'meeting.ended', { organizationId, meetingId }, { organizationId, actorId });
    return rows[0]!;
  });
}

export async function endMeeting(actor: Actor, meetingId: string): Promise<MeetingView> {
  const meeting = await loadMeeting(meetingId);
  await assertCanView(actor, meeting);

  if (meeting.host_id !== actor.userId) {
    throw AppError.permission('Only the host can end this meeting');
  }

  const ended = await endMeetingInternal(meetingId, meeting.organization_id, actor.userId);
  return toMeetingView(ended);
}

export async function sendChatMessage(
  actor: Actor,
  meetingId: string,
  text: string,
): Promise<MeetingMessageView> {
  const meeting = await loadMeeting(meetingId);
  await assertCanView(actor, meeting);

  if (!meeting.allow_chat && meeting.host_id !== actor.userId) {
    throw AppError.permission('Chat is disabled for this meeting');
  }

  const user = await findUserById(actor.userId);
  const row = await queryOne<{ id: string; sender_name: string; sender_id: string; body: string; created_at: Date }>(
    `INSERT INTO meeting_messages (meeting_id, sender_id, sender_name, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, sender_id, sender_name, body, created_at`,
    [meetingId, actor.userId, user?.full_name ?? 'Unknown', text],
  );

  return {
    id: row!.id,
    sender: row!.sender_name,
    senderId: row!.sender_id,
    text: row!.body,
    time: row!.created_at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    createdAt: row!.created_at.toISOString(),
  };
}

export async function updateParticipantState(
  actor: Actor,
  meetingId: string,
  updates: { isMuted?: boolean; isVideoOn?: boolean },
): Promise<MeetingParticipantView[]> {
  const meeting = await loadMeeting(meetingId);
  await assertCanView(actor, meeting);

  if (updates.isMuted === false && !meeting.allow_unmute && meeting.host_id !== actor.userId) {
    throw AppError.permission('The host has disabled unmuting for participants');
  }

  const result = await query(
    `UPDATE meeting_participants
        SET is_muted = COALESCE($3, is_muted),
            is_video_on = COALESCE($4, is_video_on)
      WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [meetingId, actor.userId, updates.isMuted ?? null, updates.isVideoOn ?? null],
  );

  if (result.rowCount === 0) {
    throw AppError.notFound('You are not currently in this meeting');
  }

  return loadParticipants(meetingId);
}

export async function setLocked(actor: Actor, meetingId: string, isLocked: boolean): Promise<MeetingView> {
  const meeting = await loadMeeting(meetingId);

  if (meeting.host_id !== actor.userId) {
    throw AppError.permission('Only the host can lock or unlock this meeting');
  }

  const row = await queryOne<MeetingRow>(
    `UPDATE meetings SET is_locked = $2 WHERE id = $1 RETURNING ${MEETING_COLUMNS}`,
    [meetingId, isLocked],
  );

  return toMeetingView(row!, await loadParticipants(meetingId));
}
