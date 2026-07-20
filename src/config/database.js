import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDatabase() {
  if (!env.MONGO_URI) {
    throw new Error('MONGO_URI is not defined in the environment variables.');
  }

  if (mongoose.connection.readyState === 1) {
    return;
  }

  const connectionUri = env.MONGO_URI.includes('?')
    ? `${env.MONGO_URI}&db=${env.MONGO_DB_NAME}`
    : `${env.MONGO_URI}/${env.MONGO_DB_NAME}`;

  await mongoose.connect(connectionUri);
}
