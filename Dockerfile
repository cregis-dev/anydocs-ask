ARG BGE_M3_REVISION=4de13258303883538bd53b696b452bf8099f0858
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.ui.json vite.config.ts ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY README.md CHANGELOG.md PRD.md ARCHITECTURE.md ./
RUN pnpm build

FROM node:22-bookworm-slim AS engine-deps
WORKDIR /app
ENV NODE_ENV=production
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Deployable shared runtime: ship the offline model, never a site's documents.
FROM engine-deps AS model-assets
ARG BGE_M3_REVISION
ENV BGE_M3_REVISION=$BGE_M3_REVISION ANYDOCS_TRANSFORMERS_CACHE=/opt/models
RUN node --input-type=module <<'EOF'
import { env, pipeline } from '@huggingface/transformers';

env.cacheDir = '/opt/models';
env.allowRemoteModels = true;

let extractor = await pipeline('feature-extraction', 'Xenova/bge-m3', {
  dtype: 'q8',
  revision: process.env.BGE_M3_REVISION,
});
let output = await extractor('model build probe', {
  pooling: 'mean',
  normalize: true,
});
if (Array.from(output.dims).join(',') !== '1,1024') {
  throw new Error(`unexpected BGE-M3 output shape: ${output.dims}`);
}
await extractor.dispose();

env.allowRemoteModels = false;
extractor = await pipeline('feature-extraction', 'Xenova/bge-m3', {
  dtype: 'q8',
  revision: process.env.BGE_M3_REVISION,
});
output = await extractor('offline model probe', {
  pooling: 'mean',
  normalize: true,
});
if (Array.from(output.dims).join(',') !== '1,1024') {
  throw new Error(`unexpected offline BGE-M3 output shape: ${output.dims}`);
}
await extractor.dispose();
EOF
FROM engine-deps AS engine
COPY --from=build /app/dist ./dist
COPY docker/check-content.mjs ./check-content.mjs
EXPOSE 3100
CMD ["node", "dist/cli.js", "serve", "/docs", "--host", "0.0.0.0", "--port", "3100", "--workspace", "/runtime"]

FROM engine AS bge-runtime
COPY --from=model-assets /opt/models /opt/models
ARG ENGINE_REVISION
ARG BGE_M3_REVISION
ENV BGE_M3_REVISION=$BGE_M3_REVISION
ENV ANYDOCS_TRANSFORMERS_CACHE=/opt/models ANYDOCS_ENGINE_RELEASE=$ENGINE_REVISION

# Preserve the lightweight default build for users supplying their own model.
FROM engine AS runtime
