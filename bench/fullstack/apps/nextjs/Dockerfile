FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# The matched tier's build (next.config.mjs), from the same tree. EDGE_HOST is the host a browser
# reaches the app at through the bench's edge (edge.mjs: the app's port plus 1,000).
FROM build AS matched
ARG EDGE_HOST=localhost:19411
RUN rm -rf .next && PROFILE=matched EDGE_HOST=${EDGE_HOST} npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=matched /app/.next/standalone /matched/
COPY --from=matched /app/.next/static /matched/.next/static
COPY --from=matched /app/public /matched/public
EXPOSE 8080
CMD ["sh", "-c", "[ \"$PROFILE\" = matched ] && cd /matched; exec node server.js"]
