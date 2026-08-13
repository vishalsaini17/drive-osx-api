import { redis } from './client.js';
import { logger } from '../observability/logger.js';

/**
 * Cache reads never fail a request: a Redis outage degrades to a cache miss.
 * Writes are best-effort for the same reason.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error) {
    logger().warn({ err: error, key }, 'cache read failed, falling through to source');
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (error) {
    logger().warn({ err: error, key }, 'cache write failed');
  }
}

export async function cacheDelete(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (error) {
    logger().warn({ err: error, keys }, 'cache invalidation failed');
  }
}

export async function cacheDeleteByPrefix(prefix: string): Promise<void> {
  try {
    const stream = redis.scanStream({ match: `${prefix}*`, count: 200 });
    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
  } catch (error) {
    logger().warn({ err: error, prefix }, 'prefix cache invalidation failed');
  }
}

export async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;

  const value = await load();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

export const cacheKeys = {
  userProfile: (userId: string) => `cache:user:${userId}:profile`,
  membership: (userId: string, organizationId: string) => `cache:member:${organizationId}:${userId}`,
  organizationMembers: (organizationId: string) => `cache:org:${organizationId}:members`,
  unreadNotifications: (userId: string) => `cache:notifications:${userId}:unread`,
};
