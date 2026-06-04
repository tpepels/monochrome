# Node Alpine -- multi-arch (amd64 + arm64)
FROM oven/bun:1.3.11-alpine AS builder

WORKDIR /app

# Install system dependencies required for Bun
RUN apk add --no-cache wget curl bash

# Accept build arguments for environment variables
ARG AUTH_ENABLED
ARG AUTH_SECRET
ARG APPWRITE_ENDPOINT
ARG APPWRITE_PROJECT_ID
ARG POCKETBASE_URL
ARG SESSION_MAX_AGE

# Copy package files first for caching
COPY package.json bun.lock ./

# Install dependencies (Node)
RUN bun install

# Copy the rest of the project
COPY . .

# Build the project
RUN bun run build

# Serve built static assets and server-side download APIs with Bun
FROM oven/bun:1.3.11-alpine

WORKDIR /app

RUN apk add --no-cache bash curl wget ffmpeg

ENV NODE_ENV=production
ENV PORT=4173
ENV MONOCHROME_STATIC_ROOT=/app/dist

COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/functions ./functions
COPY --from=builder /app/js ./js

# Expose the app/API port
EXPOSE 4173

CMD ["bun", "server/app.js"]
