import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDatabase() {
  if (!env.MONGO_URI) {
    throw new Error('MONGO_URI is not defined in the environment variables.');
  }

  if (mongoose.connection.readyState === 1) {
    return;
  }

  await mongoose.connect(env.MONGO_URI);
}
