import { asyncHandler } from '../../../shared/common/AsyncHandler.js';
import { MeetingService } from '../services/meeting.service.js';
import { authenticate } from '../../../middleware/auth.middleware.js';

const meetingService = new MeetingService();

export const createMeeting = asyncHandler(async (req, res) => {
  const meeting = await meetingService.createMeeting(req.user.id, req.body);
  res.status(201).json({ message: 'Meeting created', meeting });
});

export const getMeeting = asyncHandler(async (req, res) => {
  const meeting = await meetingService.getMeeting(req.params.meetingId);
  res.json({ meeting });
});

export const getTodayMeetings = asyncHandler(async (req, res) => {
  const meetings = await meetingService.getTodayMeetings(req.user.id);
  res.json({ meetings });
});

export const startMeeting = asyncHandler(async (req, res) => {
  const meeting = await meetingService.startMeeting(req.params.meetingId, req.user.id);
  res.json({ message: 'Meeting started', meeting });
});

export const joinMeeting = asyncHandler(async (req, res) => {
  const { passcode } = req.body;
  const meeting = await meetingService.joinMeeting(req.params.meetingId, req.user.id, passcode);
  res.json({ message: 'Joined meeting', meeting });
});

export const leaveMeeting = asyncHandler(async (req, res) => {
  const result = await meetingService.leaveMeeting(req.params.meetingId, req.user.id);
  res.json(result);
});

export const endMeeting = asyncHandler(async (req, res) => {
  const meeting = await meetingService.endMeeting(req.params.meetingId, req.user.id);
  res.json({ message: 'Meeting ended', meeting });
});

export const sendChatMessage = asyncHandler(async (req, res) => {
  const { text } = req.body;
  const message = await meetingService.sendChatMessage(req.params.meetingId, req.user.id, text);
  res.status(201).json({ message });
});

export const updateParticipant = asyncHandler(async (req, res) => {
  const meeting = await meetingService.updateParticipantStatus(
    req.params.meetingId,
    req.user.id,
    req.body
  );
  res.json({ meeting });
});
