# Plemmo Cloud — sync and operator API production image.
#
# One stateless Node service in front of managed PostgreSQL. It carries only what the service needs
# (express and pg — none of the desktop app's dependencies, no SQLite driver). Build from the repo root:
#   docker build -f cloud/Dockerfile -t plemmo-cloud .
#
# Run the migrations as a separate one-shot step BEFORE rolling out new server code (expand/contract):
#   docker run --rm -e PLEMMO_CLOUD_DB_URL=... plemmo-cloud node dist/run-migrations.js
FROM node:22-slim AS build
WORKDIR /app
COPY cloud/package.json cloud/package-lock.json ./
RUN npm ci
COPY cloud/ ./
RUN npx tsc -p tsconfig.build.json

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY cloud/package.json cloud/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./dist/migrations
# Drop privileges.
USER node
EXPOSE 8080
# Liveness is /health (no database); readiness is /ready (database reachable).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/serve.js"]
