import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireOrganization, requireUser } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { parseBody, parseParams, parseQuery } from '../../platform/http/validate.js';
import { rateLimit } from '../../platform/http/rate-limit.js';
import * as service from './mail.service.js';

export const mailRoutes = Router();

const MAIL_FOLDERS = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive'] as const;

const receiveSchema = z.object({
  to: z.string().trim().min(1, 'Recipient is required'),
  from: z.string().trim().min(1, 'Sender is required'),
  subject: z.string().optional(),
  body: z.string().optional(),
  recipientUsername: z.string().optional(),
});

const sendSchema = z.object({
  to: z.string().trim().min(1, 'Enter at least one recipient'),
  subject: z.string().trim().min(1, 'Subject is required').max(255),
  body: z.string().optional(),
  cc: z.string().trim().optional(),
  bcc: z.string().trim().optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        size: z.string().default(''),
        type: z.string().default(''),
        storageKey: z.string().optional(),
      }),
    )
    .optional(),
});

const listQuery = z.object({
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const emailParams = z.object({ emailId: z.string().uuid('Invalid message id') });

/**
 * Delivery endpoint for the SMTP gateway. It runs before `authenticate()`
 * because inbound mail carries no user session; it is reachable only from the
 * internal network and is rate limited.
 */
mailRoutes.post(
  '/receive',
  rateLimit({ bucket: 'mail-receive', windowSeconds: 60, max: 600 }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseBody(receiveSchema, req);
    const email = await service.receiveEmail(body);
    res.status(201).json({ message: 'Message delivered', email });
  }),
);

mailRoutes.use(authenticate());

mailRoutes.post(
  '/send',
  rateLimit({ bucket: 'mail-send', windowSeconds: 3600, max: 200 }),
  asyncHandler(async (req: Request, res: Response) => {
    const { user, organizationId } = requireOrganization(req);
    const body = parseBody(sendSchema, req);
    const email = await service.sendEmail({ userId: user.id, organizationId }, body);
    res.status(201).json({ message: 'Message sent', email });
  }),
);

function listHandler(folder: (typeof MAIL_FOLDERS)[number] | 'starred' | 'important' | undefined) {
  return asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const query = parseQuery(listQuery, req);
    const emails = await service.listMail({
      userId: user.id,
      ...(folder ? { folder } : {}),
      ...(query.q ? { search: query.q } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    res.json({ emails });
  });
}

mailRoutes.get('/inbox', listHandler('inbox'));
mailRoutes.get('/sent', listHandler('sent'));
mailRoutes.get('/starred', listHandler('starred'));
mailRoutes.get('/important', listHandler('important'));

mailRoutes.get(
  '/unread/count',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const folder = z.enum(MAIL_FOLDERS).optional().parse(req.query.folder || undefined);
    res.json({ count: await service.unreadCount(user.id, folder) });
  }),
);

mailRoutes.get(
  '/folder/:folder',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { folder } = parseParams(z.object({ folder: z.enum(MAIL_FOLDERS) }), req);
    const query = parseQuery(listQuery, req);
    const emails = await service.listMail({
      userId: user.id,
      folder,
      ...(query.q ? { search: query.q } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    res.json({ emails });
  }),
);

mailRoutes.get(
  '/:emailId',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { emailId } = parseParams(emailParams, req);
    res.json({ email: await service.getEmail(user.id, emailId) });
  }),
);

mailRoutes.patch(
  '/:emailId/read',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { emailId } = parseParams(emailParams, req);
    res.json({ message: 'Marked as read', email: await service.markRead(user.id, emailId) });
  }),
);

mailRoutes.patch(
  '/:emailId/star',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { emailId } = parseParams(emailParams, req);
    res.json({ message: 'Star toggled', email: await service.toggleFlag(user.id, emailId, 'is_starred') });
  }),
);

mailRoutes.patch(
  '/:emailId/pin',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { emailId } = parseParams(emailParams, req);
    res.json({ message: 'Pin toggled', email: await service.toggleFlag(user.id, emailId, 'is_pinned') });
  }),
);

mailRoutes.patch(
  '/:emailId/move',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { emailId } = parseParams(emailParams, req);
    const { folder } = parseBody(z.object({ folder: z.enum(MAIL_FOLDERS) }), req);
    res.json({ message: 'Message moved', email: await service.moveToFolder(user.id, emailId, folder) });
  }),
);

mailRoutes.delete(
  '/:emailId',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { emailId } = parseParams(emailParams, req);
    const result = await service.deleteEmail(user.id, emailId);
    res.json({
      message: result.deleted ? 'Message permanently deleted' : 'Message moved to trash',
      permanentlyDeleted: result.deleted,
    });
  }),
);
