import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDatabase() {
  if (!env.MONGO_URI) {
    throw new Error('MONGO_URI is not defined in the environment variables.');
  }

  if (mongoose.connection.readyState === 1) {
    console.log('MongoDB is already connected.');
    return;
  }

  try {
    await mongoose.connect(env.MONGO_URI);

    console.log(
      `MongoDB connected successfully: ${mongoose.connection.host}/${mongoose.connection.name}`
    );
  } catch (error) {
    console.error('MongoDB connection failed:', error);
    process.exit(1);
  }
}