# CLAUDE.md — AgentsMarketplace

## Project Overview

AI Agent service marketplace on X Layer (Chain 196) with x402 micropayments. Integrates 13 OKX Onchain OS Skills + 4 Uniswap AI Skills for Skill-driven AI decision-making.

## Architecture

- `scripts/agent-server.mjs` — Main server (Express, Claude tool_use, OKX + Uniswap APIs, x402 middleware)
- `scripts/skills-loader.mjs` — Loads SKILL.md files from onchainos-skills/ and uniswap-ai/ at startup
- `scripts/agentic-wallet.mjs` — OKX Agentic Wallet wrapper (onchainos CLI, TEE signing)
- `scripts/mcp-server.mjs` — MCP Server (JSON-RPC over stdio, 9 tools)
- `src/*.sol` — Foundry smart contracts (AgentRegistry, TaskManager, ReputationEngine, X402Rating)
- `docs/index.html` — Frontend SPA
- `sdk/xlayeragent-sdk.mjs` — Agent SDK

## Commands

```bash
npm install              # install dependencies
npm test                 # forge test (Solidity contracts)
node scripts/agent-server.mjs   # start server (needs env vars)
node scripts/skills-loader.mjs  # test Skill loading
node scripts/agentic-wallet.mjs # test wallet module
```

## Key Patterns

- x402 middleware: `x402Guard(pricePath)` on protected routes
- Claude tool_use: `ASK_TOOLS` array + `executeAskTool()` switch
- OKX API: `okxRequest(method, path, body)` with HMAC-SHA256
- Uniswap API: `uniswapRequest(endpoint, body)` with x-api-key header
- Dual engine: `dualEngineQuote()` compares OKX vs Uniswap in parallel
- Agent payment: `agentPay(url)` handles full 402 challenge/response cycle

## Deployed Contracts (X Layer 196)

- AgentRegistry: `0x7337a8963Dc7Cf0644f9423bBE397b3D0f97ACa1`
- TaskManager: `0x599e23D6073426eBe357d03056258eEAa217e01D`
- ReputationEngine: `0x3bf87bf49141B014e4Eef71A661988624c1af29F`
- X402Rating: `0x85Be67F1A3c1f470A6c94b3C77fD326d3c0f1188`
