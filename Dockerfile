# Base images come from AWS's public mirror of Docker's official images: the
# same images, without Docker Hub's anonymous pull limit, which has failed
# builds on shared CI runners.
FROM public.ecr.aws/docker/library/node:26.11.1-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# ── builder stage: compile TypeScript ─────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:26.11.1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── runner stage: production deps + compiled output ───────────────────────────
FROM public.ecr.aws/docker/library/node:26.11.1-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Build identity, supplied by the pipeline (scripts/print-app-version.cjs) and
# frozen into the image. GET /version reads these, so the container never needs
# git or the repository to say what it is. The environment it runs in is NOT
# baked: it is supplied at run time, so one image can be promoted from alpha to
# beta to production unchanged.
ARG APP_VERSION
ARG GIT_SHA
ARG BUILD_ID
ARG BUILT_AT
ENV HAA_APP_VERSION=$APP_VERSION
ENV HAA_GIT_SHA=$GIT_SHA
ENV HAA_BUILD_ID=$BUILD_ID
ENV HAA_BUILT_AT=$BUILT_AT
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 expressjs

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder --chown=expressjs:nodejs /app/dist ./dist
COPY --chown=expressjs:nodejs package.json ./

USER expressjs
EXPOSE 4000
CMD ["node", "dist/server.js"]
