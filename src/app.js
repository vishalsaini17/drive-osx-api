import express from 'express';
import cors from 'cors';
import authRoutes from './features/auth/routes/auth.routes.js';
import workspaceRoutes from './features/workspaces/routes/workspace.routes.js';
import { connectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { setupSwagger } from './docs/swagger.js';

export async function createApp() {
  const app = express();
  app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
  app.options('*', cors());
  app.use(express.json());

  app.use(`/api/${env.API_VERSION}`, authRoutes);
  app.use(`/api/${env.API_VERSION}/workspaces`, workspaceRoutes);
  setupSwagger(app);

  return app;
}

export async function startApp() {
  await connectDatabase();

  const app = await createApp();
  app.listen(env.PORT, () => {
    console.log(`Server running on http://localhost:${env.PORT}`);
  });
}
