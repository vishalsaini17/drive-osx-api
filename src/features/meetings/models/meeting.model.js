import mongoose from 'mongoose';

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['scheduled', 'active', 'ended', 'cancelled'], default: 'scheduled', index: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date },
    passcode: { type: String, default: '' },
    waitingRoomEnabled: { type: Boolean, default: true },
    allowScreenShare: { type: Boolean, default: true },
    allowChat: { type: Boolean, default: true },
    allowUnmute: { type: Boolean, default: true },
    allowRecording: { type: Boolean, default: true },
    isLocked: { type: Boolean, default: false },
    participants: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        name: { type: String, required: true },
        role: { type: String, enum: ['host', 'participant'], default: 'participant' },
        isMuted: { type: Boolean, default: false },
        isVideoOn: { type: Boolean, default: false },
        joinedAt: { type: Date, default: Date.now },
        leftAt: { type: Date },
      }
    ],
    chatMessages: [
      {
        sender: { type: String, required: true },
        text: { type: String, required: true },
        time: { type: String, required: true },
        isMe: { type: Boolean, default: false },
        attachment: {
          name: { type: String },
          size: { type: String },
          type: { type: String },
        },
        createdAt: { type: Date, default: Date.now },
      }
    ],
  },
  { timestamps: true }
);

meetingSchema.index({ hostId: 1, status: 1, startTime: 1 });
meetingSchema.index({ status: 1, startTime: 1 });

export const Meeting = mongoose.model('Meeting', meetingSchema);
