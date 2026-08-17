# Build stage: compile the TypeScript wake proxy
FROM node:20-alpine AS build

WORKDIR /app/wake-proxy

COPY wake-proxy/package*.json ./
RUN npm ci

COPY wake-proxy/ ./
RUN npm run build

# Runtime stage: production dependencies + docker CLI with the compose plugin
FROM node:20-alpine

# docker-cli-compose is required: the proxy shells out to `docker compose`
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app/wake-proxy

COPY wake-proxy/package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/wake-proxy/dist ./dist

# config.json is NOT baked into the image — mount it at /app/config.json
# (see docker-compose.yml)

CMD ["node", "dist/wake-proxy.js"]
