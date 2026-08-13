import { randomUUID } from 'node:crypto';
import { query, type Queryable } from '../../infrastructure/database/pool.js';
import { logger, rootLogger, runWithContext } from '../../infrastructure/observability/logger.js';
import type { DomainEvent, DomainEventHandler, DomainEventMap, DomainEventName } from './domain-events.js';

/**
 * Transactional outbox. Events are written in the same transaction as the state
 * change that produced them, then dispatched by the worker. A crash between
 * commit and dispatch loses nothing — the row is still pending.
 */
export interface PublishOptions {
  organizationId?: string | null;
  actorId?: string | null;
}

export async function publishEvent<N extends DomainEventName>(
  tx: Queryable,
  name: N,
  payload: DomainEventMap[N],
  options: PublishOptions = {},
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO domain_events (id, name, organization_id, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, name, options.organizationId ?? null, options.actorId ?? null, JSON.stringify(payload)],
  );
  return id;
}

const handlers = new Map<DomainEventName, DomainEventHandler[]>();

export function onEvent<N extends DomainEventName>(name: N, handler: DomainEventHandler<N>): void {
  const existing = handlers.get(name) ?? [];
  existing.push(handler as DomainEventHandler);
  handlers.set(name, existing);
}

interface EventRow {
  id: string;
  name: DomainEventName;
  organization_id: string | null;
  actor_id: string | null;
  payload: DomainEventMap[DomainEventName];
  occurred_at: Date;
  attempts: number;
}

/**
 * Claims a batch of pending events with SKIP LOCKED so multiple worker
 * processes can dispatch concurrently without double-handling.
 */
export async function dispatchPendingEvents(batchSize = 50): Promise<number> {
  const { rows } = await query<EventRow>(
    `UPDATE domain_events
        SET claimed_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM domain_events
         WHERE processed_at IS NULL
           AND attempts < 5
           AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
         ORDER BY occurred_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING id, name, organization_id, actor_id, payload, occurred_at, attempts`,
    [batchSize],
  );

  for (const row of rows) {
    await dispatchOne(row);
  }

  return rows.length;
}

async function dispatchOne(row: EventRow): Promise<void> {
  const event: DomainEvent = {
    id: row.id,
    name: row.name,
    organizationId: row.organization_id,
    actorId: row.actor_id,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  };

  const registered = handlers.get(row.name) ?? [];

  await runWithContext(
    {
      requestId: row.id,
      ...(row.actor_id ? { userId: row.actor_id } : {}),
      ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    },
    async () => {
      const results = await Promise.allSettled(registered.map((handler) => handler(event)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

      if (failures.length > 0) {
        logger().error(
          { eventId: row.id, event: row.name, failures: failures.map((f) => String(f.reason)) },
          'domain event handler(s) failed; event will be retried',
        );
        // Left unprocessed: the claim expires in 5 minutes and it is retried.
        return;
      }

      await query('UPDATE domain_events SET processed_at = now() WHERE id = $1', [row.id]);
      logger().debug({ eventId: row.id, event: row.name, handlers: registered.length }, 'domain event dispatched');
    },
  );
}

export function registeredEventNames(): DomainEventName[] {
  return [...handlers.keys()];
}

export async function eventBacklog(): Promise<{ pending: number; failed: number }> {
  const { rows } = await query<{ pending: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE processed_at IS NULL AND attempts < 5) AS pending,
            count(*) FILTER (WHERE processed_at IS NULL AND attempts >= 5) AS failed
       FROM domain_events`,
  );
  return { pending: Number(rows[0]?.pending ?? 0), failed: Number(rows[0]?.failed ?? 0) };
}

export function logRegisteredHandlers(): void {
  rootLogger.info({ events: [...handlers.keys()] }, 'domain event handlers registered');
}
