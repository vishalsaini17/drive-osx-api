import dotenv from 'dotenv';

dotenv.config();

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 7000,
  MONGO_URI: process.env.MONGO_URI,
  MONGO_DB_NAME: process.env.MONGO_DB_NAME || 'drive',
  JWT_SECRET: process.env.JWT_SECRET || 'learning-node-secret',
  API_VERSION: process.env.API_VERSION || 'v1'
};
