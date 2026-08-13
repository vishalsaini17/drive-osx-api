import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireOrganization } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { parseBody, parseParams } from '../../platform/http/validate.js';
import * as service from './meetings.service.js';

export const meetingRoutes = Router();

meetingRoutes.use(authenticate());

const meetingParams = z.object({ meetingId: z.string().uuid('Invalid meeting id') });

const createSchema = z.object({
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  passcode: z.string().trim().max(32).optional(),
  waitingRoomEnabled: z.boolean().optional(),
  allowScreenShare: z.boolean().optional(),
  allowChat: z.boolean().optional(),
  allowUnmute: z.boolean().optional(),
  allowRecording: z.boolean().optional(),
});

function actorOf(req: Request): service.Actor {
  const { user, organizationId } = requireOrganization(req);
  return { userId: user.id, organizationId };
}

meetingRoutes.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseBody(createSchema, req);
    const meeting = await service.createMeeting(actorOf(req), body);
    res.status(201).json({ message: 'Meeting created', meeting });
  }),
);

meetingRoutes.get(
  '/today',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ meetings: await service.listTodayMeetings(actorOf(req)) });
  }),
);

meetingRoutes.get(
  '/:meetingId',
  asyncHandler(async (req: Request, res: Response) => {
    const { meetingId } = parseParams(meetingParams, req);
    res.json({ meeting: await service.getMeeting(actorOf(req), meetingId) });
  }),
);

meetingRoutes.post(
  '/:meetingId/start',
  asyncHandler(async (req: Request, res: Response) => {
    const { meetingId } = parseParams(meetingParams, req);
    res.json({ message: 'Meeting started', meeting: await service.startMeeting(actorOf(req), meetingId) });
  }),
);

meetingRoutes.post(
  '/:meetingId/join',
  asyncHandler(async (req: Request, res: Response) => {
    const { meetingId } = parseParams(meetingParams, req);
    const { passcode } = parseBody(z.object({ passcode: z.string().optional() }), req);
    const meeting = await service.joinMeeting(actorOf(req), meetingId, passcode);
    res.json({ message: 'Joined meeting', meeting });
  }),
);

meetingRoutes.post(
  '/:meetingId/leave',
  asyncHandler(async (req: Request, res: Response) => {
    const { meetingId } = parseParams(meetingParams, req);
    res.json(await service.leaveMeeting(actorOf(req), meetingId));
  }),
);

meetingRoutes.post(
  '/:meetingId/end',
  asyncHandler(async (req: Request, res: Response) => {
    const { meetingId } = parseParams(meetingParams, req);
    res.json({ message: 'Meeting ended', meeting: await service.endMeeting(actorOf(req), meetingId) });
  }),
);

meetingRoutes.post(
  '/:meetingId/chat',
  asyncHandler(async (req: Request, res: Response) => {
    const { meetingId } = parseParams(meetingParams, req);
    const { text } = parseBody(z.object({ text: z.string().trim().min(1, 'Message cannot be empty').max(4000) }), req);
    const message = await service.sendChatMessage(actorOf(req), meetingId, text);
    res.status(201).json({ message });
  }),
);

meetingRoutes.patch(
  '/:meetingId/participant',
  asyncHandler(async (req: Request, res: Response) => {
    const { meetingId } = parseParams(meetingParams, req);
    const body = parseBody(z.object({ isMuted: z.boolean().optional(), isVideoOn: z.boolean().optional() }), req);
    const participants = await service.updateParticipantState(actorOf(req), meetingId, body);
    res.json({ participants });
  }),
);

meetingRoutes.patch(
  '/:meetingId/lock',
  asyncHandler(async (req: Request, res: Response) => {
    const { meetingId } = parseParams(meetingParams, req);
    const { isLocked } = parseBody(z.object({ isLocked: z.boolean() }), req);
    res.json({ meeting: await service.setLocked(actorOf(req), meetingId, isLocked) });
  }),
);
