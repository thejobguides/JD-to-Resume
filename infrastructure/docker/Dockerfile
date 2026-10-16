# One image for both Node services: docker build -f infrastructure/docker/Dockerfile -t jmo-server .
# APP picks the service at run time (api, the default, or admin-api); the build arg only sets that default
# (Cloudflare Containers pass it as image_vars, Render sets APP as an environment variable). The server listens on
# PORT when the host injects one (Render), else 8787 (api) / 8788 (admin-api). Migrations are a release step:
# pnpm deploy:prod db
FROM node:20.20-slim
ARG APP=api
ENV APP=${APP} NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/admin-api ./apps/admin-api
RUN pnpm install --frozen-lockfile --filter "@jmo/api..." --filter "@jmo/admin-api..." --filter "@jmo/db..."
USER node
EXPOSE 8787 8788
# tsx directly, not `pnpm start`: corepack would download pnpm on every cold start (hosts that sleep when idle).
CMD ["sh", "-c", "cd apps/${APP} && exec /app/node_modules/.bin/tsx src/node.ts"]
