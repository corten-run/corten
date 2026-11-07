FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
# Astro emits middleware separately and normally imports it lazily. Preload before listening
# so the fixture is parsed at startup; a changed adapter entry fails startup rather than loading lazily.
CMD ["node", "--import", "./dist/server/virtual_astro_middleware.mjs", "dist/server/entry.mjs"]
