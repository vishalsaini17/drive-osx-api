import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireUser } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { parseParams, parseQuery } from '../../platform/http/validate.js';
import * as service from './notifications.service.js';

export const notificationRoutes = Router();

notificationRoutes.use(authenticate());

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

notificationRoutes.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const query = parseQuery(listQuery, req);
    const notifications = await service.listNotifications(user.id, query);
    res.json({ notifications });
  }),
);

notificationRoutes.get(
  '/unread/count',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    res.json({ count: await service.unreadCount(user.id) });
  }),
);

notificationRoutes.patch(
  '/:notificationId/read',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { notificationId } = parseParams(z.object({ notificationId: z.string().uuid() }), req);
    await service.markRead(user.id, notificationId);
    res.json({ message: 'Notification marked as read' });
  }),
);

notificationRoutes.post(
  '/read-all',
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const updated = await service.markAllRead(user.id);
    res.json({ message: 'All notifications marked as read', updated });
  }),
);
