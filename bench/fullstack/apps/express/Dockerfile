FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
WORKDIR /app
# Express's production guide: NODE_ENV=production, which (among other things) caches the views.
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ADD --checksum=sha256:a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130 https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js static/htmx.min.js
EXPOSE 8080
CMD ["node", "server.mjs"]
