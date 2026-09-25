# Plemmo Cloud — sync API production image (COMMERCIALIZATION, Part A).
#
# The smallest reliable deployment: one stateless Node service behind the
# managed PostgreSQL chosen in DEPLOYMENT.md. Build from the repo root:
#   docker build -f cloud/Dockerfile -t plemmo-cloud .
#
# The container runs cloud/serve.ts (compiled). Run migrations as a separate
# one-shot step BEFORE rolling out new server code (expand/contract):
#   docker run --rm -e PLEMMO_CLOUD_DB_URL=... plemmo-cloud node dist-cloud/run-migrations.js
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev=false
COPY cloud ./cloud
COPY tsconfig.json ./tsconfig.json
# Compile the cloud service only (its own tsconfig emits to dist-cloud/).
RUN npx tsc -p cloud/tsconfig.json --outDir dist-cloud

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Only the runtime deps + compiled output.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist-cloud ./dist-cloud
COPY --from=build /app/cloud/migrations ./dist-cloud/migrations
# Drop privileges.
USER node
EXPOSE 8080
# Liveness/readiness are served at /health and /ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist-cloud/serve.js"]
