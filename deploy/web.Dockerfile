# Web image: the built renderer (static files) served by nginx, which also proxies /api
# to the server container.
#
# Build:  docker build -f deploy/web.Dockerfile -t duix-avatar-web .
# Run:    see docker-compose.yml
FROM node:20-bookworm-slim AS build

WORKDIR /build

# Dependencies first so the layer is cached across source changes. --ignore-scripts skips the
# root `postinstall` (electron-builder install-app-deps), which is irrelevant for the web build.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY vite.config.mjs ./
COPY scripts ./scripts
COPY src ./src

# Copies the ffmpeg.wasm core into src/renderer/public/ffmpeg (git-ignored) and builds.
RUN npm run build:web

FROM nginx:1.27-alpine AS runtime

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist/web /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

STOPSIGNAL SIGQUIT