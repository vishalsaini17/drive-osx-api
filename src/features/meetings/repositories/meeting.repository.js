import mongoose from 'mongoose';
import { Meeting } from '../models/meeting.model.js';

export async function createMeeting(payload) {
  return Meeting.create(payload);
}

export async function findMeetingById(meetingId) {
  return Meeting.findById(meetingId);
}

export async function findMeetingsByHost(hostId) {
  return Meeting.find({ hostId }).sort({ startTime: -1 });
}

export async function findActiveMeeting(meetingId) {
  return Meeting.findOne({ _id: meetingId, status: 'active' });
}

export async function updateMeeting(meetingId, updates) {
  return Meeting.findByIdAndUpdate(meetingId, updates, { new: true });
}

export async function addParticipantToMeeting(meetingId, participant) {
  return Meeting.findByIdAndUpdate(
    meetingId,
    { $push: { participants: participant } },
    { new: true }
  );
}

export async function removeParticipantFromMeeting(meetingId, userId) {
  return Meeting.findByIdAndUpdate(
    meetingId,
    {
      $pull: { participants: { userId } },
      $set: { 'participants.$.leftAt': new Date() }
    },
    { new: true }
  );
}

export async function addChatMessage(meetingId, message) {
  return Meeting.findByIdAndUpdate(
    meetingId,
    { $push: { chatMessages: message } },
    { new: true }
  );
}

export async function listTodayMeetings(userId) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  return Meeting.find({
    $or: [
      { hostId: userId },
      { 'participants.userId': userId }
    ],
    startTime: { $gte: todayStart, $lte: todayEnd },
    status: { $in: ['scheduled', 'active'] }
  }).sort({ startTime: 1 });
}

export async function endMeeting(meetingId) {
  return Meeting.findByIdAndUpdate(
    meetingId,
    { status: 'ended', endTime: new Date() },
    { new: true }
  );
}
