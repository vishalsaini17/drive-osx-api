import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireOrganization } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { parseBody, parseParams, parseQuery } from '../../platform/http/validate.js';
import { RESOURCE_ROLES } from '../../platform/authorization/roles.js';
import * as service from './sharing.service.js';

export const sharingRoutes = Router();

const fileParams = z.object({ fileId: z.string().uuid('Invalid file id') });
const shareParams = z.object({ shareId: z.string().uuid('Invalid share id') });

const shareUserSchema = z
  .object({
    userId: z.string().uuid().optional(),
    usernameOrEmail: z.string().trim().min(1).optional(),
    role: z.enum(RESOURCE_ROLES).default('viewer'),
    message: z.string().max(500).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .refine((data) => data.userId ?? data.usernameOrEmail, {
    message: 'Provide a userId or a username/email',
    path: ['usernameOrEmail'],
  });

const shareTeamSchema = z.object({
  teamId: z.string().uuid('Invalid team id'),
  role: z.enum(RESOURCE_ROLES).default('viewer'),
});

const shareLinkSchema = z.object({
  role: z.enum(RESOURCE_ROLES).default('viewer'),
  expiresAt: z.string().datetime().optional(),
});

function actorOf(req: Request): service.Actor {
  const { user, organizationId } = requireOrganization(req);
  return { userId: user.id, organizationId };
}

// Public: opening a share link does not require an account.
sharingRoutes.get(
  '/links/:token',
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = parseParams(z.object({ token: z.string().min(10) }), req);
    const result = await service.resolveShareLink(token);
    res.json(result);
  }),
);

sharingRoutes.use(authenticate());

sharingRoutes.get(
  '/shared-with-me',
  asyncHandler(async (req: Request, res: Response) => {
    const files = await service.listSharedWithMe(actorOf(req));
    res.json({ files });
  }),
);

sharingRoutes.get(
  '/files/:fileId',
  asyncHandler(async (req: Request, res: Response) => {
    const { fileId } = parseParams(fileParams, req);
    const shares = await service.listSharesForFile(actorOf(req), fileId);
    res.json({ shares });
  }),
);

sharingRoutes.get(
  '/files/:fileId/eligible-users',
  asyncHandler(async (req: Request, res: Response) => {
    const { fileId } = parseParams(fileParams, req);
    const { q } = parseQuery(z.object({ q: z.string().trim().max(120).default('') }), req);
    const users = await service.searchEligibleUsers(actorOf(req), fileId, q);
    res.json({ users });
  }),
);

sharingRoutes.get(
  '/files/:fileId/activity',
  asyncHandler(async (req: Request, res: Response) => {
    const { fileId } = parseParams(fileParams, req);
    const activity = await service.listFileActivity(actorOf(req), fileId);
    res.json({ activity });
  }),
);

sharingRoutes.post(
  '/files/:fileId/users',
  asyncHandler(async (req: Request, res: Response) => {
    const { fileId } = parseParams(fileParams, req);
    const body = parseBody(shareUserSchema, req);
    const share = await service.shareWithUser(actorOf(req), { fileId, ...body });
    res.status(201).json({ message: 'File shared', share });
  }),
);

sharingRoutes.post(
  '/files/:fileId/teams',
  asyncHandler(async (req: Request, res: Response) => {
    const { fileId } = parseParams(fileParams, req);
    const body = parseBody(shareTeamSchema, req);
    const share = await service.shareWithTeam(actorOf(req), { fileId, ...body });
    res.status(201).json({ message: 'File shared with team', share });
  }),
);

sharingRoutes.post(
  '/files/:fileId/links',
  asyncHandler(async (req: Request, res: Response) => {
    const { fileId } = parseParams(fileParams, req);
    const body = parseBody(shareLinkSchema, req);
    const result = await service.createShareLink(actorOf(req), { fileId, ...body });
    // The token is shown once; it cannot be recovered from the stored hash.
    res.status(201).json({ message: 'Share link created', share: result.share, token: result.token });
  }),
);

sharingRoutes.delete(
  '/:shareId',
  asyncHandler(async (req: Request, res: Response) => {
    const { shareId } = parseParams(shareParams, req);
    await service.revokeShare(actorOf(req), shareId);
    res.json({ message: 'Access revoked' });
  }),
);
