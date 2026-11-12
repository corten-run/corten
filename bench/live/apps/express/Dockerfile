FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs client.js ./
ENV PORT=8080
USER node
CMD ["node", "server.mjs"]
