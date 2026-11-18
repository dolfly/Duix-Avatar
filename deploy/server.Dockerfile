# API server image (rqlite metadata store + media storage + GPU service orchestration).
#
# Build:  docker build -f deploy/server.Dockerfile -t duix-avatar-server .
FROM node:20-bookworm-slim AS deps

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8280 \
    DATA_DIR=/data

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server/src ./src

# /data holds face2face/ (model videos, audio and results) and voice/data (voice cloning
# reference audio). It is mounted from ./data in docker-compose.yml.
RUN mkdir -p /data/face2face/temp /data/voice/data/origin_audio

EXPOSE 8280

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8280/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]