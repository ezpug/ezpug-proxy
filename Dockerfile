FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/ezpug/ezpug-proxy" \
      org.opencontainers.image.description="EZPug venue relay: ezLAN token and userinfo calls through the LAN" \
      org.opencontainers.image.licenses="UNLICENSED"
WORKDIR /relay
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY relay.mjs ./
USER node
ENV NODE_ENV=production
# Node is PID 1 here; relay.mjs handles SIGTERM itself and closes the line.
CMD ["node", "relay.mjs"]
