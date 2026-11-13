# Single-service image: builds the React app and runs the API, which also serves the built frontend.
FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npx prisma generate
COPY --from=web /app/web/dist /app/web/dist
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["sh", "scripts/start.sh"]
