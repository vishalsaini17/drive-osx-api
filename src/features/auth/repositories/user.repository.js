import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: false, lowercase: true, trim: true },
    recoveryEmail: { type: String, required: true, lowercase: true, trim: true },
    mobile: { type: String, required: false, trim: true },
    password: { type: String, required: true },
    currentWorkspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null },
    resetToken: { type: String, default: null },
    resetTokenExpiry: { type: Date, default: null }
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);

export async function findUserByEmail(email) {
  return User.findOne({ email });
}

export async function createUser(payload) {
  return User.create(payload);
}

export async function findUserByUsername(username) {
  return User.findOne({ username });
}

export async function updateUser(userId, payload) {
  return User.findByIdAndUpdate(userId, payload, { new: true });
}

export async function findUserByResetToken(resetToken) {
  return User.findOne({
    resetToken,
    resetTokenExpiry: { $gt: new Date() }
  });
}
