import { query, queryMany, type Queryable } from '../../infrastructure/database/pool.js';
import { currentContext, logger } from '../../infrastructure/observability/logger.js';

/**
 * Audit logging (CLAUDE.md §28, §34). Entries are append-only and describe who
 * did what to which resource, in which tenant.
 */
export interface AuditEntry {
  organizationId: string | null;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const INSERT_SQL = `
  INSERT INTO audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata, ip_address, user_agent, request_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`;

function params(entry: AuditEntry): unknown[] {
  return [
    entry.organizationId,
    entry.actorId,
    entry.action,
    entry.resourceType,
    entry.resourceId ?? null,
    JSON.stringify(entry.metadata ?? {}),
    entry.ipAddress ?? null,
    entry.userAgent ?? null,
    currentContext()?.requestId ?? null,
  ];
}

/** Writes the entry inside the caller's transaction — the audit trail commits with the change. */
export async function recordAudit(tx: Queryable, entry: AuditEntry): Promise<void> {
  await tx.query(INSERT_SQL, params(entry));
}

/**
 * Out-of-transaction variant for read-only or already-committed actions
 * (logins, downloads). Failure to audit must not fail the user's request, but
 * it is logged at error level rather than swallowed.
 */
export function recordAuditDetached(entry: AuditEntry): void {
  query(INSERT_SQL, params(entry)).catch((error) => {
    logger().error({ err: error, action: entry.action }, 'failed to write audit log entry');
  });
}

export interface AuditLogView {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export function listAuditLogs(input: {
  organizationId: string;
  action?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  actorId?: string | undefined;
  limit: number;
  offset: number;
}): Promise<AuditLogView[]> {
  return queryMany<AuditLogView>(
    `SELECT a.id,
            a.action,
            a.resource_type AS "resourceType",
            a.resource_id   AS "resourceId",
            a.actor_id      AS "actorId",
            u.full_name     AS "actorName",
            a.metadata,
            a.ip_address    AS "ipAddress",
            a.created_at    AS "createdAt"
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.organization_id = $1
        AND ($2::text IS NULL OR a.action = $2)
        AND ($3::text IS NULL OR a.resource_type = $3)
        AND ($4::text IS NULL OR a.resource_id = $4)
        AND ($5::uuid IS NULL OR a.actor_id = $5)
      ORDER BY a.created_at DESC
      LIMIT $6 OFFSET $7`,
    [
      input.organizationId,
      input.action ?? null,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.actorId ?? null,
      input.limit,
      input.offset,
    ],
  );
}
