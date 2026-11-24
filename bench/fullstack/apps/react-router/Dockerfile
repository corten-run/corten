FROM node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/server.mjs ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
EXPOSE 8080
CMD ["node", "server.mjs"]
