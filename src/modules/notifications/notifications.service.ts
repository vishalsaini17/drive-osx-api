import { query, queryMany, queryOne, type Queryable } from '../../infrastructure/database/pool.js';
import { redis } from '../../infrastructure/redis/client.js';
import { cacheDelete, cacheKeys } from '../../infrastructure/redis/cache.js';
import { logger } from '../../infrastructure/observability/logger.js';

/**
 * Notifications are durable in PostgreSQL and additionally published on a Redis
 * channel so a connected client sees them immediately (CLAUDE.md §22).
 */
export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface CreateNotificationInput {
  organizationId: string | null;
  userId: string;
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

const CHANNEL = 'realtime:notifications';

export async function createNotification(
  tx: Queryable,
  input: CreateNotificationInput,
): Promise<{ id: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO notifications (organization_id, user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.organizationId,
      input.userId,
      input.type,
      input.title,
      input.body ?? '',
      JSON.stringify(input.data ?? {}),
    ],
  );

  const created = rows[0]!;
  await publishRealtime(input.userId, { id: created.id, ...input });
  await cacheDelete(cacheKeys.unreadNotifications(input.userId));
  return created;
}

async function publishRealtime(userId: string, payload: unknown): Promise<void> {
  try {
    await redis.publish(CHANNEL, JSON.stringify({ userId, payload }));
  } catch (error) {
    // The row is committed; live delivery is best-effort and the client will
    // still see it on the next poll or reconnect.
    logger().warn({ err: error, userId }, 'could not publish realtime notification');
  }
}

export function listNotifications(
  userId: string,
  options: { unreadOnly?: boolean; limit: number; offset: number },
): Promise<NotificationView[]> {
  return queryMany<NotificationView>(
    `SELECT id, type, title, body, data,
            read_at    AS "readAt",
            created_at AS "createdAt"
       FROM notifications
      WHERE user_id = $1
        AND ($2::boolean = false OR read_at IS NULL)
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
    [userId, options.unreadOnly ?? false, options.limit, options.offset],
  );
}

export async function unreadCount(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    'SELECT count(*) AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return Number(row?.count ?? 0);
}

export async function markRead(userId: string, notificationId: string): Promise<void> {
  await query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [
    notificationId,
    userId,
  ]);
  await cacheDelete(cacheKeys.unreadNotifications(userId));
}

export async function markAllRead(userId: string): Promise<number> {
  const result = await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [
    userId,
  ]);
  await cacheDelete(cacheKeys.unreadNotifications(userId));
  return result.rowCount ?? 0;
}
