import type { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { apiBasePath, env } from '../configuration/env.js';

/**
 * Hand-authored contract for the endpoints external clients depend on.
 * Routes are also enumerated at runtime (`/docs.json` → `x-routes`) so a new
 * endpoint is visible even before it is documented here.
 */
const document = {
  openapi: '3.0.3',
  info: {
    title: 'Drive OSX Platform API',
    version: env.API_VERSION,
    description:
      'Platform API for the Drive OSX web operating environment. ' +
      'Every tenant-scoped endpoint resolves the organization from the session; ' +
      'send X-Organization-Id to act in a workspace other than the current one.',
  },
  servers: [{ url: apiBasePath }],
  tags: [
    { name: 'Identity', description: 'Registration, sessions and profiles' },
    { name: 'Organizations', description: 'Workspaces, members and teams' },
    { name: 'Files', description: 'Drive metadata, contents, versions' },
    { name: 'Sharing', description: 'Permission grants and share links' },
    { name: 'Mail', description: 'Mailboxes and delivery' },
    { name: 'Meetings', description: 'Meetings, participants and chat' },
    { name: 'Platform', description: 'Notifications, search, audit, health' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          error: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                enum: [
                  'validation_error',
                  'authentication_error',
                  'permission_error',
                  'not_found',
                  'conflict',
                  'quota_exceeded',
                  'rate_limited',
                  'storage_error',
                  'dependency_error',
                  'internal_error',
                ],
              },
              message: { type: 'string' },
              details: { nullable: true },
              retryable: { type: 'boolean' },
              requestId: { type: 'string' },
            },
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          username: { type: 'string' },
          fullName: { type: 'string' },
          email: { type: 'string' },
          organizationId: { type: 'string', format: 'uuid', nullable: true },
        },
      },
      File: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['file', 'folder'] },
          mimeType: { type: 'string' },
          size: { type: 'integer' },
          parentId: { type: 'string', format: 'uuid', nullable: true },
          starred: { type: 'boolean' },
          version: { type: 'integer' },
          content: { type: 'string', description: 'Present for small text files only' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/register': {
      post: {
        tags: ['Identity'],
        summary: 'Create an account, its personal workspace and its drive',
        security: [],
        responses: {
          201: { description: 'Account created' },
          409: { description: 'Username already taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/login': {
      post: {
        tags: ['Identity'],
        summary: 'Exchange credentials for an access and refresh token',
        security: [],
        responses: { 200: { description: 'Signed in' }, 401: { description: 'Invalid credentials' } },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Identity'],
        summary: 'Rotate a refresh token for a new access token',
        security: [],
        responses: { 200: { description: 'Session refreshed' }, 401: { description: 'Session expired' } },
      },
    },
    '/profile': {
      get: { tags: ['Identity'], summary: 'Current user', responses: { 200: { description: 'Profile' } } },
      patch: { tags: ['Identity'], summary: 'Update the current user', responses: { 200: { description: 'Updated' } } },
    },
    '/organizations': {
      get: { tags: ['Organizations'], summary: 'Workspaces the user belongs to', responses: { 200: { description: 'List' } } },
      post: { tags: ['Organizations'], summary: 'Create a workspace', responses: { 201: { description: 'Created' } } },
    },
    '/files': {
      post: { tags: ['Files'], summary: 'Create a file or folder', responses: { 201: { description: 'Created' } } },
    },
    '/files/children/{parentId}': {
      get: {
        tags: ['Files'],
        summary: 'List a folder (omit parentId for the drive root)',
        parameters: [{ name: 'parentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Folder contents' } },
      },
    },
    '/files/upload': {
      post: {
        tags: ['Files'],
        summary: 'Upload file contents (multipart/form-data)',
        responses: { 201: { description: 'Stored' }, 413: { description: 'Over quota or too large' } },
      },
    },
    '/files/{fileId}/download': {
      get: {
        tags: ['Files'],
        summary: 'Short-lived direct download URL',
        parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Signed URL' } },
      },
    },
    '/files/{fileId}/versions': {
      get: {
        tags: ['Files'],
        summary: 'Version history',
        parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Versions' } },
      },
    },
    '/shares/files/{fileId}/links': {
      post: {
        tags: ['Sharing'],
        summary: 'Create a share link (token is returned once)',
        parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 201: { description: 'Link created' }, 403: { description: 'Blocked by the workspace sharing policy' } },
      },
    },
    '/mail/inbox': {
      get: { tags: ['Mail'], summary: 'List the inbox', responses: { 200: { description: 'Messages' } } },
    },
    '/mail/send': {
      post: { tags: ['Mail'], summary: 'Send a message', responses: { 201: { description: 'Sent' } } },
    },
    '/meetings': {
      post: { tags: ['Meetings'], summary: 'Schedule a meeting', responses: { 201: { description: 'Created' } } },
    },
    '/search': {
      get: {
        tags: ['Platform'],
        summary: 'Search across files and mail',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Ranked results' } },
      },
    },
    '/notifications': {
      get: { tags: ['Platform'], summary: 'List notifications', responses: { 200: { description: 'Notifications' } } },
    },
    '/audit-logs': {
      get: { tags: ['Platform'], summary: 'Read the workspace audit trail', responses: { 200: { description: 'Entries' } } },
    },
    '/health/ready': {
      get: { tags: ['Platform'], summary: 'Readiness probe', security: [], responses: { 200: { description: 'Ready' }, 503: { description: 'Degraded' } } },
    },
  },
};

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: RouteLayer[] };
  regexp?: RegExp;
}

/** Enumerates what the app actually serves, mount prefixes included. */
export function listRoutes(app: Express): string[] {
  const routes: string[] = [];

  const walk = (layers: RouteLayer[] | undefined, prefix: string): void => {
    for (const layer of layers ?? []) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods)
          .filter((method) => layer.route!.methods[method])
          .map((method) => method.toUpperCase())
          .join(',');
        routes.push(`${methods} ${prefix}${layer.route.path}`.replace(/\/{2,}/g, '/'));
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  };

  walk((app as unknown as { _router?: { stack: RouteLayer[] } })._router?.stack, '');
  return [...new Set(routes)].sort();
}

export function mountApiDocs(app: Express): void {
  const docsPath = `${apiBasePath}/docs`;

  app.get(`${docsPath}.json`, (_req: Request, res: Response) => {
    res.json({ ...document, 'x-routes': listRoutes(app) });
  });

  app.use(docsPath, swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'Drive OSX API', explorer: true }));
}
