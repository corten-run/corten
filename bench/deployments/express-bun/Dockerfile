ARG NODE_IMAGE
ARG BUN_IMAGE
FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
# One npm resolution and one filesystem for BOTH runtimes. No Bun package install,
# bundling, replacement server, response cache or alternate middleware.
COPY bench/fullstack/apps/express/package.json ./
RUN npm install --no-audit --no-fund
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY bench/fullstack/apps/express/server.mjs ./
COPY bench/fullstack/apps/express/lib ./lib
COPY bench/fullstack/apps/express/views ./views
COPY bench/fullstack/apps/express/static ./static
ADD --checksum=sha256:a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130 https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js static/htmx.min.js
COPY bench/deployments/express-bun/identity.mjs /qualification/identity.mjs
EXPOSE 8080
CMD ["node", "server.mjs"]
