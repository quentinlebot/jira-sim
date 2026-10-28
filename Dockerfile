# The Jira simulator as a server with its state in MongoDB, for compose.yaml (docker compose up -d --build).
# Production install only: no dev dependencies, just the optional mongodb and pg drivers.

FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts ./scripts
RUN npm run compile

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/out ./out
COPY media/simulator.html ./media/simulator.html
USER node
EXPOSE 4865
CMD ["node", "out/cli.js", "--host", "0.0.0.0", "--port", "4865"]