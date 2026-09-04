import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Unit tests cover pure domain logic; infrastructure is exercised by the
    // integration smoke suite against a running stack.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      STORAGE_ENDPOINT: 'http://localhost:9000',
      STORAGE_ACCESS_KEY: 'test',
      STORAGE_SECRET_KEY: 'test',
      JWT_SECRET: 'test-secret-value-at-least-16',
    },
  },
});
