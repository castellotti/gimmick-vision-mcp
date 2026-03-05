# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
COPY src/ ./src/
RUN npm ci --ignore-scripts && npm run build

# Runtime stage
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/build ./build

ENV NODE_ENV=production
# Override at runtime:
#   VISION_API_BASE  http://host.docker.internal:8081/v1
#   VISION_MODEL     qwen2.5-vl-7b
#   VISION_TIMEOUT   60000

CMD ["node", "build/index.js"]