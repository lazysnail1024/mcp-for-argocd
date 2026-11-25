FROM node:22-slim AS pnpm-base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Run pnpm non-interactively in container builds without a TTY.
ENV CI=true
RUN corepack enable
WORKDIR /app

FROM pnpm-base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# Run the build on the NATIVE builder platform (--platform=$BUILDPLATFORM), not
# the target platform. tsup/esbuild ship a Go binary that can crash under QEMU
# emulation when cross-building. Output is architecture-independent JS.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm run build

# Minimal slim runtime stage containing only package.json, prod dependencies, and compiled dist/.
FROM node:22-slim AS runtime
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3000
# Loopback default is preserved intentionally; widening bind requires explicit
# MCP_BIND_ADDRESS=0.0.0.0 alongside MCP_AUTH_TOKEN or --allow-unauthenticated.
ENTRYPOINT [ "node", "dist/index.js" ]
CMD [ "http" ]
USER 1000
