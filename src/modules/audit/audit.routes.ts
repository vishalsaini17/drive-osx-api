import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireOrganization } from '../../platform/authentication/authenticate.js';
import { requirePermission } from '../../platform/authorization/access-control.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { parseQuery } from '../../platform/http/validate.js';
import { listAuditLogs } from './audit.service.js';

export const auditRoutes = Router();

auditRoutes.use(authenticate());

const listQuery = z.object({
  action: z.string().trim().optional(),
  resourceType: z.string().trim().optional(),
  resourceId: z.string().trim().optional(),
  actorId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

auditRoutes.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { user, organizationId } = requireOrganization(req);
    // Audit trails are administrative data: only roles with audit:read see them.
    await requirePermission(user.id, organizationId, 'audit:read');

    const query = parseQuery(listQuery, req);
    const logs = await listAuditLogs({ organizationId, ...query });

    res.json({ logs, pagination: { limit: query.limit, offset: query.offset, count: logs.length } });
  }),
);
