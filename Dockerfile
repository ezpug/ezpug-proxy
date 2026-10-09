FROM node:22-alpine
WORKDIR /relay
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY relay.mjs ./
USER node
ENV NODE_ENV=production
# Node is PID 1 here; relay.mjs handles SIGTERM itself and closes the line.
CMD ["node", "relay.mjs"]
