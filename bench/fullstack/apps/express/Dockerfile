FROM node:24-bookworm-slim
WORKDIR /app
# Express's production guide: NODE_ENV=production, which (among other things) caches the views.
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
ADD --checksum=sha256:d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717 https://unpkg.com/htmx.org@2.0.11/dist/htmx.min.js static/htmx.min.js
EXPOSE 8080
CMD ["node", "server.mjs"]
