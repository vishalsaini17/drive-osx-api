import { AppError } from '../../../shared/common/AppError.js';
import { User } from '../../auth/repositories/user.repository.js';
import {
  createMeeting,
  findMeetingById,
  findMeetingsByHost,
  findActiveMeeting,
  updateMeeting,
  addParticipantToMeeting,
  removeParticipantFromMeeting,
  addChatMessage,
  listTodayMeetings,
  endMeeting
} from '../repositories/meeting.repository.js';

export class MeetingService {
  async createMeeting(hostId, payload) {
    const user = await User.findById(hostId);
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const meetingCode = `meet-${Math.floor(1000 + Math.random() * 9000)}-${Math.random().toString(36).substring(2, 5)}`;

    const meeting = await createMeeting({
      title: payload.title || 'New Meeting',
      description: payload.description || '',
      hostId,
      status: 'scheduled',
      startTime: new Date(payload.startTime || Date.now()),
      endTime: payload.endTime ? new Date(payload.endTime) : null,
      passcode: payload.passcode || '',
      waitingRoomEnabled: payload.waitingRoomEnabled ?? true,
      allowScreenShare: payload.allowScreenShare ?? true,
      allowChat: payload.allowChat ?? true,
      allowUnmute: payload.allowUnmute ?? true,
      allowRecording: payload.allowRecording ?? true,
      isLocked: false,
      participants: [
        {
          userId: hostId,
          name: user.fullName || user.username,
          role: 'host',
          isMuted: false,
          isVideoOn: false,
          joinedAt: new Date(),
        }
      ],
      chatMessages: [],
    });

    return {
      ...meeting.toObject(),
      meetingCode,
    };
  }

  async getMeeting(meetingId) {
    const meeting = await findMeetingById(meetingId);
    if (!meeting) {
      throw new AppError(404, 'Meeting not found');
    }
    return meeting;
  }

  async getTodayMeetings(userId) {
    return listTodayMeetings(userId);
  }

  async startMeeting(meetingId, userId) {
    const meeting = await findMeetingById(meetingId);
    if (!meeting) {
      throw new AppError(404, 'Meeting not found');
    }

    if (meeting.status === 'ended') {
      throw new AppError(400, 'Meeting has already ended');
    }

    if (meeting.status === 'cancelled') {
      throw new AppError(400, 'Meeting has been cancelled');
    }

    const updated = await updateMeeting(meetingId, { status: 'active', startTime: new Date() });
    return updated;
  }

  async joinMeeting(meetingId, userId, passcode) {
    const meeting = await findMeetingById(meetingId);
    if (!meeting) {
      throw new AppError(404, 'Meeting not found');
    }

    if (meeting.status === 'ended') {
      throw new AppError(400, 'Meeting has already ended');
    }

    if (meeting.status === 'cancelled') {
      throw new AppError(400, 'Meeting has been cancelled');
    }

    if (meeting.isLocked) {
      throw new AppError(403, 'Meeting is locked by the host');
    }

    if (meeting.passcode && passcode !== meeting.passcode) {
      throw new AppError(403, 'Incorrect meeting passcode');
    }

    const user = await User.findById(userId);
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const existingParticipant = meeting.participants.find(
      (p) => p.userId && p.userId.toString() === userId.toString()
    );

    if (!existingParticipant) {
      await addParticipantToMeeting(meetingId, {
        userId,
        name: user.fullName || user.username,
        role: 'participant',
        isMuted: false,
        isVideoOn: false,
        joinedAt: new Date(),
      });
    }

    return meeting;
  }

  async leaveMeeting(meetingId, userId) {
    const meeting = await findMeetingById(meetingId);
    if (!meeting) {
      throw new AppError(404, 'Meeting not found');
    }

    await removeParticipantFromMeeting(meetingId, userId);

    const remainingParticipants = meeting.participants.filter(
      (p) => p.userId && p.userId.toString() !== userId.toString()
    );

    if (remainingParticipants.length === 0) {
      await endMeeting(meetingId);
    }

    return { message: 'Left meeting successfully' };
  }

  async endMeeting(meetingId, userId) {
    const meeting = await findMeetingById(meetingId);
    if (!meeting) {
      throw new AppError(404, 'Meeting not found');
    }

    if (meeting.hostId.toString() !== userId.toString()) {
      throw new AppError(403, 'Only the host can end the meeting');
    }

    const ended = await endMeeting(meetingId);
    return ended;
  }

  async sendChatMessage(meetingId, userId, text) {
    const meeting = await findMeetingById(meetingId);
    if (!meeting) {
      throw new AppError(404, 'Meeting not found');
    }

    const user = await User.findById(userId);
    const message = {
      sender: user ? (user.fullName || user.username) : 'Unknown',
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isMe: false,
      createdAt: new Date(),
    };

    const updated = await addChatMessage(meetingId, message);
    return updated.chatMessages[updated.chatMessages.length - 1];
  }

  async updateParticipantStatus(meetingId, userId, updates) {
    const meeting = await findMeetingById(meetingId);
    if (!meeting) {
      throw new AppError(404, 'Meeting not found');
    }

    const participantIndex = meeting.participants.findIndex(
      (p) => p.userId && p.userId.toString() === userId.toString()
    );

    if (participantIndex === -1) {
      throw new AppError(404, 'Participant not found in meeting');
    }

    const updatedParticipants = [...meeting.participants];
    updatedParticipants[participantIndex] = {
      ...updatedParticipants[participantIndex],
      ...updates,
    };

    return Meeting.findByIdAndUpdate(
      meetingId,
      { participants: updatedParticipants },
      { new: true }
    );
  }
}
