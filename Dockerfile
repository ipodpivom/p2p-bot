FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --node-linker=hoisted
COPY src ./src
COPY scripts ./scripts
COPY .env.example ./
RUN mkdir -p data secrets && chown -R node:node /app
USER node
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "src/index.mjs"]
