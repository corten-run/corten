FROM node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# Keep package fetches and npm warnings/errors in the log without a full npm trace.
RUN timeout --verbose --kill-after=10s 10m \
    npm ci --no-audit --no-fund --fetch-timeout=60000 --loglevel=http
COPY . .
# The matched tier builds its own image with --build-arg PROFILE=matched (apps.mjs, buildArgs):
# Next.js fixes its config when it builds (next.config.mjs), which reads both arguments from the
# build's environment. EDGE_HOST is the host a browser reaches the app at through the bench's edge
# (edge.mjs: the app's port plus 1,000). Without PROFILE the build is as before.
ARG PROFILE=
ARG EDGE_HOST=localhost:19411
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
ARG PROFILE=
ARG EDGE_HOST=localhost:19411
ENV PROFILE=$PROFILE EDGE_HOST=$EDGE_HOST
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json /app/next.config.mjs /app/server.mjs /app/server-profile.mjs /app/marketplace-origin.ts ./
COPY --from=build /app/public ./public
EXPOSE 8080
CMD ["node", "server.mjs"]
