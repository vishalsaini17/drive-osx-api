import express from 'express';
import { authenticate } from '../../../middleware/auth.middleware.js';
import {
  createMeeting,
  getMeeting,
  getTodayMeetings,
  startMeeting,
  joinMeeting,
  leaveMeeting,
  endMeeting,
  sendChatMessage,
  updateParticipant
} from '../controllers/meeting.controller.js';

const router = express.Router();

router.post('/', authenticate, createMeeting);
router.get('/today', authenticate, getTodayMeetings);
router.get('/:meetingId', authenticate, getMeeting);
router.post('/:meetingId/start', authenticate, startMeeting);
router.post('/:meetingId/join', authenticate, joinMeeting);
router.post('/:meetingId/leave', authenticate, leaveMeeting);
router.post('/:meetingId/end', authenticate, endMeeting);
router.post('/:meetingId/chat', authenticate, sendChatMessage);
router.patch('/:meetingId/participant', authenticate, updateParticipant);

export default router;
