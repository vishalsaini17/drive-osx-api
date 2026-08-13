import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { apiBasePath, env, isProduction } from './platform/configuration/env.js';
import { rootLogger } from './infrastructure/observability/logger.js';
import { errorHandler, notFoundHandler } from './platform/http/error-handler.js';
import { rateLimit } from './platform/http/rate-limit.js';
import { requestContext } from './platform/http/request-context.js';
import { healthRoutes } from './platform/http/health.routes.js';
import { mountApiDocs } from './platform/http/openapi.js';
import { identityRoutes } from './modules/identity/identity.routes.js';
import { organizationRoutes } from './modules/organizations/organizations.routes.js';
import { fileRoutes } from './modules/files/files.routes.js';
import { sharingRoutes } from './modules/sharing/sharing.routes.js';
import { mailRoutes } from './modules/mail/mail.routes.js';
import { meetingRoutes } from './modules/meetings/meetings.routes.js';
import { notificationRoutes } from './modules/notifications/notifications.routes.js';
import { searchRoutes } from './modules/search/search.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { messagingRoutes } from './modules/messaging/messaging.routes.js';
import { contactRoutes } from './modules/contacts/contacts.routes.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining'],
    }),
  );

  app.use(requestContext());
  app.use(
    pinoHttp({
      logger: rootLogger,
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/') !== true || req.url.includes('/health') },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'debug';
      },
    }),
  );

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // Health endpoints live outside the versioned path too, so container probes
  // do not have to track the API version.
  app.use('/', healthRoutes);
  app.use(apiBasePath, healthRoutes);

  // A broad ceiling on API traffic; individual routes add tighter buckets.
  app.use(apiBasePath, rateLimit({ bucket: 'api' }));

  app.use(apiBasePath, identityRoutes);
  app.use(`${apiBasePath}/organizations`, organizationRoutes);
  // Legacy alias — the shipped client still calls /workspaces.
  app.use(`${apiBasePath}/workspaces`, organizationRoutes);
  app.use(`${apiBasePath}/files`, fileRoutes);
  app.use(`${apiBasePath}/shares`, sharingRoutes);
  app.use(`${apiBasePath}/mail`, mailRoutes);
  app.use(`${apiBasePath}/meetings`, meetingRoutes);
  app.use(`${apiBasePath}/notifications`, notificationRoutes);
  app.use(`${apiBasePath}/search`, searchRoutes);
  app.use(`${apiBasePath}/audit-logs`, auditRoutes);
  app.use(`${apiBasePath}/messaging`, messagingRoutes);
  app.use(`${apiBasePath}/contacts`, contactRoutes);

  if (!isProduction) {
    mountApiDocs(app);
  }

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
