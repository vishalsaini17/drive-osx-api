import mongoose from 'mongoose';

const emailSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    from: { type: String, required: true, lowercase: true, trim: true },
    to: { type: String, required: true, lowercase: true, trim: true },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    folder: { type: String, required: true, enum: ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive'], default: 'inbox' },
    isUnread: { type: Boolean, default: true },
    isStarred: { type: Boolean, default: false },
    isPinned: { type: Boolean, default: false },
    isImportant: { type: Boolean, default: false },
    labels: [{ type: String, trim: true }],
    attachments: [
      {
        id: { type: String, required: true },
        name: { type: String, required: true },
        size: { type: String, default: '' },
        type: { type: String, default: '' }
      }
    ],
    dateISO: { type: String, default: () => new Date().toISOString() },
    timestamp: { type: String, default: '' }
  },
  { timestamps: true }
);

export const Email = mongoose.model('Email', emailSchema);
