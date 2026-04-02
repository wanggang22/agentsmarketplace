FROM node:20-slim

WORKDIR /app

# Install onchainos CLI for Agentic Wallet (TEE signing)
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* \
  && curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/refs/heads/main/install.sh | sh \
  || echo "onchainos install failed (non-fatal, will use fallback signing)"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts/ ./scripts/
COPY sdk/ ./sdk/
COPY skills/ ./skills/

EXPOSE 3080

CMD ["node", "scripts/agent-server.mjs"]
