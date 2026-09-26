# The API image. Built from the repo root because the API uses the shared workspace
# and db/migrations. azd builds it in the container registry (see azure.yaml).
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY api api
COPY db db
COPY scripts/bundle-api.sh scripts/
RUN sh scripts/bundle-api.sh && cd api/.deploy && npm install --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /src/api/.deploy ./
USER node
EXPOSE 8080
CMD ["node", "api/dist/src/server.js"]
