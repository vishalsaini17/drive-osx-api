import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, requireOrganization } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { rateLimit } from '../../platform/http/rate-limit.js';
import { parseBody, parseParams, parseQuery } from '../../platform/http/validate.js';
import { AppError } from '../../platform/errors/app-error.js';
import * as service from './messaging.service.js';

export const messagingRoutes = Router();

messagingRoutes.use(authenticate());

// Buffered in memory, then streamed to object storage. 10 MB comfortably
// covers a compressed voice note; the service enforces the same limit so an
// oversized body is rejected even if this changes later.
const uploadVoiceMessage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function actorOf(req: Request): service.Actor {
  const { user, organizationId } = requireOrganization(req);
  return { userId: user.id, organizationId };
}

const conversationParams = z.object({ conversationId: z.string().uuid('Invalid conversation id') });
const requestParams = z.object({ requestId: z.string().uuid('Invalid request id') });
const messageParams = z.object({ messageId: z.string().uuid('Invalid message id') });

// --- Directory ------------------------------------------------------------

messagingRoutes.get(
  '/users/search',
  asyncHandler(async (req: Request, res: Response) => {
    const { q, limit } = parseQuery(
      z.object({ q: z.string().trim().max(120).default(''), limit: z.coerce.number().int().min(1).max(50).optional() }),
      req,
    );
    res.json({ users: await service.searchUsers(actorOf(req), q, limit) });
  }),
);

// --- Chat requests --------------------------------------------------------

messagingRoutes.get(
  '/requests',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ requests: await service.listChatRequests(actorOf(req)) });
  }),
);

messagingRoutes.post(
  '/requests',
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseBody(
      z.object({
        recipientId: z.string().uuid('Invalid recipient id'),
        // A request carries a short introduction, not a conversation.
        message: z.string().trim().min(1, 'Add a short message').max(280),
      }),
      req,
    );
    const request = await service.sendChatRequest(actorOf(req), body);
    res.status(201).json({ message: 'Chat request sent', request });
  }),
);

messagingRoutes.post(
  '/requests/:requestId/respond',
  asyncHandler(async (req: Request, res: Response) => {
    const { requestId } = parseParams(requestParams, req);
    const { action } = parseBody(z.object({ action: z.enum(['accept', 'reject']) }), req);
    const result = await service.respondToChatRequest(actorOf(req), requestId, action);
    res.json({ message: `Request ${result.status}`, ...result });
  }),
);

messagingRoutes.delete(
  '/requests/:requestId',
  asyncHandler(async (req: Request, res: Response) => {
    const { requestId } = parseParams(requestParams, req);
    await service.cancelChatRequest(actorOf(req), requestId);
    res.json({ message: 'Request cancelled' });
  }),
);

// --- Conversations and messages -------------------------------------------

messagingRoutes.get(
  '/conversations',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ conversations: await service.listConversations(actorOf(req)) });
  }),
);

// Declared before /conversations/:conversationId/... so "with" is never
// mistaken for a conversation id.
messagingRoutes.get(
  '/conversations/with/:userId',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = parseParams(z.object({ userId: z.string().uuid('Invalid user id') }), req);
    const conversationId = await service.findOrReviveDirectConversation(actorOf(req), userId);
    res.json({ conversationId });
  }),
);

messagingRoutes.get(
  '/conversations/:conversationId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId } = parseParams(conversationParams, req);
    const { limit, before } = parseQuery(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        before: z.string().datetime().optional(),
      }),
      req,
    );
    res.json({ messages: await service.listMessages(actorOf(req), conversationId, { limit, before }) });
  }),
);

messagingRoutes.post(
  '/conversations/:conversationId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId } = parseParams(conversationParams, req);
    const body = parseBody(
      z.object({
        body: z.string().trim().min(1, 'A message cannot be empty').max(8000),
        replyToId: z.string().uuid().optional(),
        threadParentId: z.string().uuid().optional(),
        mentions: z.array(z.string().trim().max(120)).max(50).optional(),
      }),
      req,
    );
    const message = await service.sendMessage(actorOf(req), conversationId, body);
    res.status(201).json({ message: 'Message sent', data: message });
  }),
);

messagingRoutes.post(
  '/conversations/:conversationId/voice-message',
  rateLimit({ bucket: 'upload', windowSeconds: 60, max: 120 }),
  uploadVoiceMessage.single('audio'),
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId } = parseParams(conversationParams, req);
    const uploaded = req.file;
    if (!uploaded) throw AppError.validation('No recording was included in the upload');

    const { durationSeconds } = parseBody(
      z.object({ durationSeconds: z.coerce.number().int().min(0).max(3600).optional() }),
      req,
    );

    const message = await service.sendVoiceMessage(actorOf(req), conversationId, {
      buffer: uploaded.buffer,
      mimeType: uploaded.mimetype || 'audio/webm',
      size: uploaded.size,
      durationSeconds,
    });
    res.status(201).json({ message: 'Voice message sent', data: message });
  }),
);

messagingRoutes.post(
  '/conversations/:conversationId/clear',
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId } = parseParams(conversationParams, req);
    await service.clearConversationHistory(actorOf(req), conversationId);
    res.json({ message: 'Chat cleared' });
  }),
);

messagingRoutes.post(
  '/conversations/:conversationId/read',
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId } = parseParams(conversationParams, req);
    await service.markConversationRead(actorOf(req), conversationId);
    res.json({ message: 'Conversation marked as read' });
  }),
);

messagingRoutes.get(
  '/conversations/:conversationId/media',
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId } = parseParams(conversationParams, req);
    res.json({ media: await service.listMedia(actorOf(req), conversationId) });
  }),
);

messagingRoutes.delete(
  '/conversations/:conversationId',
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId } = parseParams(conversationParams, req);
    await service.deleteConversation(actorOf(req), conversationId);
    res.json({ message: 'Chat deleted' });
  }),
);

messagingRoutes.delete(
  '/messages/:messageId',
  asyncHandler(async (req: Request, res: Response) => {
    const { messageId } = parseParams(messageParams, req);
    await service.deleteMessage(actorOf(req), messageId);
    res.json({ message: 'Message deleted' });
  }),
);
