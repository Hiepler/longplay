# Single-container deploy: API (tsx) serves the built web SPA on one origin.
FROM node:24-bookworm-slim

WORKDIR /app

# Install all workspace deps (dev deps included — needed to build the web bundle).
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# npm install (not ci): the lockfile may omit Linux-only optional native deps (Vite/rolldown,
# esbuild) when generated on macOS; install resolves the right platform binaries.
RUN npm install --no-audit --no-fund

# Build the web SPA bundle → apps/web/dist (served by the API at runtime).
# Use the bundle-only build (Vite); type-checking is enforced separately in dev/CI.
RUN npm run build:bundle -w @longplay/web

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=3000
EXPOSE 3000

# tsx runs the TypeScript API directly (matches dev; resolves the .ts workspace exports + node:sqlite).
CMD ["npm", "run", "start:prod"]
