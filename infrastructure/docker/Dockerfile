# One image per Node service: docker build -f infrastructure/docker/Dockerfile --build-arg APP=api -t jmo-api .
#                             (APP=admin-api for the admin API). Run migrations as a release step:
#                             docker run --rm -e DATABASE_URL=… jmo-api pnpm db:migrate
FROM node:20.20-slim
ARG APP=api
ENV APP=${APP} NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/${APP} ./apps/${APP}
RUN pnpm install --frozen-lockfile --filter "@jmo/${APP}..." --filter "@jmo/db..."
USER node
EXPOSE 8787 8788
CMD ["sh", "-c", "pnpm --filter @jmo/${APP} start"]
