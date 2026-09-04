# syntax=docker/dockerfile:1
#
# One Dockerfile, several targets — development and production share the same
# base image and dependency resolution, so the two environments cannot drift.
#
#   docker build --target dev .          → watch mode, all dependencies
#   docker build --target production .   → compiled output, runtime deps only
#
# This image serves both the API (dist/main.js) and the worker (dist/worker.js);
# compose overrides the command for the worker.

ARG NODE_VERSION=24.13-alpine

# ---------------------------------------------------------------- dependencies
FROM node:${NODE_VERSION} AS deps

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: no dependency lifecycle script runs during install.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# ----------------------------------------------------------------------- build
FROM deps AS build

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ------------------------------------------------------- dependencies (dev)
# Installed as the `node` user so node_modules is writable at runtime. The dev
# server writes its dependency cache into node_modules, and the anonymous
# volume Compose creates from this directory inherits these permissions.
FROM node:${NODE_VERSION} AS deps-dev

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 npm ci --ignore-scripts

# ------------------------------------------------------------------------- dev
# Source is bind-mounted over /app at runtime; the baked copy only makes the
# image usable on its own.
FROM deps-dev AS dev

ENV NODE_ENV=development

COPY --chown=node:node . .

EXPOSE 7000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "dev"]

# ------------------------------------------------------------------ production
FROM node:${NODE_VERSION} AS production

WORKDIR /app
ENV NODE_ENV=production

# Runtime dependencies only — no compiler, no test tooling in the final image.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist

# `node` (uid 1000) ships with the base image; the app never needs root.
USER node

EXPOSE 7000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form: the process is PID 1 and receives SIGTERM directly, so the
# graceful shutdown in main.ts/worker.ts actually runs.
CMD ["node", "dist/main.js"]
