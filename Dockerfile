FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --loglevel=error
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app

# su-exec is a small (~30 KB) replacement for gosu used to drop privileges
# from root to the unprivileged "node" user after the entrypoint has fixed
# bind-mount ownership.
RUN apk add --no-cache su-exec

COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev --loglevel=error
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# /app/data is the canonical data path; the bind mount or named volume is
# attached here at runtime.
RUN mkdir -p /app/data

ENV PORT=6767
ENV NODE_ENV=production
# Override these at runtime (docker-compose `environment:`) to make the
# container run as your host user. Defaults to the alpine "node" user (1000).
ENV PUID=1000
ENV PGID=1000

EXPOSE 6767
VOLUME ["/app/data"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
