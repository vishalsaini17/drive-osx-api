import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { env } from '../config/env.js';

const apiBasePath = `/api/${env.API_VERSION}`;

const swaggerOptions = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Learning Node API',
      version: env.API_VERSION,
      description: 'Enterprise-ready API documentation for the learning-node service.'
    },
    servers: [
      {
        url: apiBasePath,
        description: 'Current API server'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    }
  },
  apis: ['src/**/*.js']
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

export function setupSwagger(app) {
  const docsPath = `${apiBasePath}/docs`;

  app.use(docsPath, swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Learning Node API Docs',
    explorer: true
  }));

  app.get(`${docsPath}.json`, (_req, res) => {
    res.json(swaggerSpec);
  });

  console.log(`Swagger docs available at ${docsPath}`);
}
