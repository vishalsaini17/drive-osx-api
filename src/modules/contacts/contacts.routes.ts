import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireOrganization } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { parseBody, parseParams, parseQuery } from '../../platform/http/validate.js';
import * as service from './contacts.service.js';

export const contactRoutes = Router();

contactRoutes.use(authenticate());

function actorOf(req: Request): service.Actor {
  const { user, organizationId } = requireOrganization(req);
  return { userId: user.id, organizationId };
}

const contactParams = z.object({ contactId: z.string().uuid('Invalid contact id') });

const contactBody = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().email('Enter a valid email address').max(255).nullish(),
  phone: z.string().trim().max(40).nullish(),
  company: z.string().trim().max(160).nullish(),
  jobTitle: z.string().trim().max(160).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  address: z.string().trim().max(400).nullish(),
  website: z.string().trim().max(400).nullish(),
  // Accepts YYYY-MM-DD, or an empty string meaning "clear this field".
  birthday: z
    .string()
    .trim()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use the format YYYY-MM-DD')
    .nullish(),
  department: z.string().trim().max(160).nullish(),
  team: z.string().trim().max(160).nullish(),
  labels: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  isFavourite: z.boolean().optional(),
  contactUserId: z.string().uuid('Invalid user id').nullish(),
});

contactRoutes.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { search, favourites } = parseQuery(
      z.object({
        search: z.string().trim().max(120).optional(),
        favourites: z.coerce.boolean().optional(),
      }),
      req,
    );
    const contacts = await service.listContacts(actorOf(req), {
      search,
      favouritesOnly: favourites,
    });
    res.json({ contacts });
  }),
);

contactRoutes.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseBody(contactBody, req);
    const contact = await service.createContact(actorOf(req), body);
    res.status(201).json({ message: 'Contact saved', contact });
  }),
);

// --- presence -------------------------------------------------------------
// Declared before /:contactId so "presence" is not parsed as an id.

contactRoutes.post(
  '/presence/heartbeat',
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseBody(
      z.object({
        status: z.enum(['online', 'away', 'busy', 'dnd', 'offline']).optional(),
        statusText: z.string().trim().max(140).optional(),
        statusEmoji: z.string().trim().max(16).optional(),
      }),
      req,
    );
    res.json({ presence: await service.heartbeat(actorOf(req), body) });
  }),
);

contactRoutes.post(
  '/presence/offline',
  asyncHandler(async (req: Request, res: Response) => {
    await service.goOffline(actorOf(req));
    res.json({ message: 'Marked offline' });
  }),
);

contactRoutes.post(
  '/presence/lookup',
  asyncHandler(async (req: Request, res: Response) => {
    const { userIds } = parseBody(
      z.object({ userIds: z.array(z.string().uuid()).max(200) }),
      req,
    );
    res.json({ presence: await service.presenceFor(actorOf(req), userIds) });
  }),
);

// --- individual contacts --------------------------------------------------

contactRoutes.get(
  '/:contactId',
  asyncHandler(async (req: Request, res: Response) => {
    const { contactId } = parseParams(contactParams, req);
    res.json({ contact: await service.getContact(actorOf(req), contactId) });
  }),
);

contactRoutes.patch(
  '/:contactId',
  asyncHandler(async (req: Request, res: Response) => {
    const { contactId } = parseParams(contactParams, req);
    const body = parseBody(contactBody, req);
    const contact = await service.updateContact(actorOf(req), contactId, body);
    res.json({ message: 'Contact updated', contact });
  }),
);

contactRoutes.delete(
  '/:contactId',
  asyncHandler(async (req: Request, res: Response) => {
    const { contactId } = parseParams(contactParams, req);
    await service.deleteContact(actorOf(req), contactId);
    res.json({ message: 'Contact removed' });
  }),
);
