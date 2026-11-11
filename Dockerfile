# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code.
COPY src ./src
COPY scripts ./scripts

# Data directory must be writable by the non-root runtime user.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
