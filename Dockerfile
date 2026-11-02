# ── StockFlow production image ───────────────────────────────────────────────
# Multi-stage: install prod deps, then copy only what the server needs.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 needs a toolchain when no prebuilt binary matches this platform.
RUN apk add --no-cache python3 make g++ \
 && npm ci --omit=dev \
 && npm cache clean --force

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4173

# Run unprivileged. The `node` user ships with the official image.
RUN mkdir -p /app/data && chown -R node:node /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node supabase ./supabase

USER node
EXPOSE 4173

# /api/health returns {ok:true} and performs a real DB round-trip.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
