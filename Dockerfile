# syntax=docker/dockerfile:1
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --chown=node:node . .

ENV NODE_ENV=production
EXPOSE 7000

USER node

CMD ["npm", "start"]
