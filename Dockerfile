FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY README.md CHANGELOG.md PRD.md ARCHITECTURE.md ./
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
EXPOSE 3100
CMD ["node", "dist/cli.js", "serve", "/docs", "--host", "0.0.0.0", "--port", "3100", "--workspace", "/runtime"]
