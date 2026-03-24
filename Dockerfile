FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts/agent-server.mjs ./scripts/
COPY sdk/ ./sdk/

EXPOSE 3080

CMD ["node", "scripts/agent-server.mjs"]
