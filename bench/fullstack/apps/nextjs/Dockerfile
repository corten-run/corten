FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
# The matched tier builds its own image with --build-arg PROFILE=matched (apps.mjs, buildArgs):
# Next.js fixes its config when it builds (next.config.mjs), which reads both arguments from the
# build's environment. EDGE_HOST is the host a browser reaches the app at through the bench's edge
# (edge.mjs: the app's port plus 1,000). Without PROFILE the build is as before.
ARG PROFILE=
ARG EDGE_HOST=localhost:19411
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 8080
CMD ["node", "server.js"]
