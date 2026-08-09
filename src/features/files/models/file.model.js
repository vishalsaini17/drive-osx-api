import mongoose from 'mongoose';

const fileSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true, enum: ['file', 'folder'], default: 'file' },
    mimeType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', index: true, default: null },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    storageKey: { type: String, default: '' },
    content: { type: String, default: '' },
    starred: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null, index: true },
    metadata: { type: Map, of: String, default: {} },
    versions: [
      {
        id: { type: String, required: true },
        content: { type: String, default: '' },
        size: { type: Number, default: 0 },
        createdAt: { type: Date, default: Date.now },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      }
    ]
  },
  { timestamps: true }
);

fileSchema.index({ ownerId: 1, parentId: 1, deletedAt: 1 });
fileSchema.index({ ownerId: 1, name: 1, parentId: 1 });
fileSchema.index({ ownerId: 1, starred: 1, deletedAt: 1 });
fileSchema.index(
  { name: 'text', content: 'text', mimeType: 'text' },
  { weights: { name: 10, content: 5, mimeType: 2 } }
);

export const File = mongoose.model('File', fileSchema);
