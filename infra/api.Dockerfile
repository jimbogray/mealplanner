# API container image. Build from the repository root:
#   docker build -f infra/api.Dockerfile -t mealplanner-api .
# The same image runs the API (default command) and the migration job
# (command: node api/dist/src/migrate.js).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --workspace shared --workspace api --include-workspace-root
COPY shared shared
COPY api api
RUN npm run build --workspace shared && npm run build --workspace api

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace shared --workspace api --include-workspace-root

FROM node:20-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/api/package.json api/package.json
COPY --from=build /app/api/dist api/dist
COPY db db
USER node
EXPOSE 8080
CMD ["node", "api/dist/src/server.js"]
