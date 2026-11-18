# Node + SQLite is the provisional default self-hosted runtime (ADR-0001).
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/agent/package.json apps/agent/package.json
RUN npm ci --omit=dev

FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/agent.sqlite \
    PI_DATABASE_PATH=/data/pi.sqlite
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY apps/agent/src ./apps/agent/src
COPY scripts/preflight.ts ./scripts/preflight.ts
COPY scripts/backup.ts ./scripts/backup.ts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
# `exec` keeps SIGTERM on PID 1 so the Node shutdown path closes both SQLite files.
CMD ["sh", "-c", "node scripts/preflight.ts && exec node apps/agent/src/main.ts"]
