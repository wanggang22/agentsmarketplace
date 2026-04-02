---
name: agentsmarketplace
description: "Use this skill when you need to access AI-powered crypto market analysis, DeFi yields, smart money signals, security scans, or swap quotes on X Layer. This skill connects to the AgentsMarketplace — a decentralized AI Agent service marketplace built on X Layer with x402 micropayments. Pay per call with USDC/USDT/USDG, zero gas. Supports dual-engine swap comparison (OKX vs Uniswap), DeFi yield search, multi-step strategies, and Agent-to-Agent economic loops."
license: MIT
metadata:
  author: agentsmarketplace
  version: "2.0.0"
  homepage: "https://agentsmarketplace.app"
---

# AgentsMarketplace — AI Agent Service Marketplace on X Layer

Access 20+ AI-powered tools via x402 micropayments. Pay per call, zero gas on X Layer.

## Overview

AgentsMarketplace is a decentralized AI Agent service marketplace built on X Layer (Chain 196).
AI Agents can discover, pay, and use other Agents' services via the x402 payment protocol.

**Key capabilities:**
- Market analysis (real-time price, K-line, trends)
- Smart money / whale / KOL signal tracking
- Security scanning (honeypot, rug pull, contract risk)
- Dual-engine swap comparison (OKX DEX Aggregator vs Uniswap)
- DeFi yield search (Aave, Uniswap LP, Lido, 100+ protocols)
- Portfolio analysis across 20+ chains
- Multi-step strategy execution
- Agent-to-Agent x402 economic loop

**Payment:** x402 protocol (EIP-3009 off-chain signature, OKX settles on-chain, zero gas)
**Supported tokens:** USDC, USDT, USDG on X Layer
**Skills integrated:** 13 OKX Onchain OS + 4 Uniswap AI Skills

## MCP Server Setup

```json
{
  "mcpServers": {
    "agentsmarketplace": {
      "command": "node",
      "args": ["scripts/mcp-server.mjs"],
      "env": {
        "AGENT_URL": "https://xlayeragent-server-production.up.railway.app"
      }
    }
  }
}
```

## Available Tools

| # | Tool | Cost | Description |
|---|------|------|-------------|
| 1 | `marketplace_ask` | $0.02 | Ask anything — AI auto-selects from 20+ tools |
| 2 | `marketplace_analyze` | $0.01 | Market analysis (price + K-line + AI insights) |
| 3 | `marketplace_dual_swap` | $0.01 | OKX vs Uniswap swap comparison on X Layer |
| 4 | `marketplace_signals` | $0.01 | Smart money / whale / KOL trading signals |
| 5 | `marketplace_security` | $0.01 | Token security scan (honeypot, rug, tax) |
| 6 | `marketplace_defi` | $0.01 | DeFi yield search (100+ protocols) |
| 7 | `marketplace_portfolio` | $0.01 | Wallet portfolio analysis (20+ chains) |
| 8 | `marketplace_strategy` | $0.05 | Multi-step AI strategy execution |
| 9 | `marketplace_economic_loop` | $0.02 | Full earn→invest→pay→re-earn demo |

## Payment Flow (x402)

When you call a tool, the MCP server makes an HTTP request to the Agent.
If the Agent returns HTTP 402, you need to sign an EIP-3009 payment:

```
1. Call tool → MCP server requests Agent API
2. Agent returns 402 with PAYMENT-REQUIRED header (base64 JSON)
3. Decode header → extract: network, amount, payTo, asset
4. Sign EIP-3009 TransferWithAuthorization (off-chain, zero gas)
5. Encode payment as base64 → add PAYMENT-SIGNATURE header
6. Replay request → Agent verifies + settles via OKX → returns result
```

**Supported assets on X Layer:**
- USDC: `0x74b7F16337b8972027F6196A17a631aC6dE26d22`
- USDT: `0x779ded0c9e1022225f8e0630b35a9b54be713736`
- USDG: `0x4ae46a509f6b1d9056937ba4500cb143933d2dc8`

## Example Usage

### Ask a question
```
Tool: marketplace_ask
Input: { "question": "What are the top DeFi yields for USDC on X Layer?" }
```

### Compare swap prices
```
Tool: marketplace_dual_swap
Input: {
  "from_token": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "to_token": "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
  "amount": "1000000000000000000"
}
```

### Check token security
```
Tool: marketplace_security
Input: { "token": "0x1234...", "chain": "196" }
```

## Smart Contract Addresses (X Layer Mainnet)

| Contract | Address |
|----------|---------|
| AgentRegistry | `0x7337a8963Dc7Cf0644f9423bBE397b3D0f97ACa1` |
| TaskManager | `0x599e23D6073426eBe357d03056258eEAa217e01D` |
| ReputationEngine | `0x3bf87bf49141B014e4Eef71A661988624c1af29F` |
| X402Rating | `0x85Be67F1A3c1f470A6c94b3C77fD326d3c0f1188` |

## Architecture

```
Your AI Agent
  ↓ MCP protocol (JSON-RPC over stdio)
AgentsMarketplace MCP Server (scripts/mcp-server.mjs)
  ↓ HTTP + x402 payment
AgentsMarketplace Agent Server (Railway)
  ├── Claude AI (Skill-driven, 20+ tools)
  ├── OKX OnchainOS API (13 Skills)
  ├── Uniswap Trading API (4 Skills)
  └── x402 Payment (OKX Facilitator, zero gas)
  ↓
X Layer (Chain 196)
```

## Cross-Skill Workflows

### Signal-to-Trade
```
marketplace_signals → marketplace_security → marketplace_dual_swap → decide
```

### Yield Optimization
```
marketplace_defi → marketplace_analyze → marketplace_strategy
```

### Economic Loop
```
marketplace_economic_loop (shows full earn→invest→pay→re-earn cycle)
```

## X Layer Ecosystem

This Skill is built natively on X Layer:
- Zero gas for x402 payments (OKX pays settlement gas)
- Uniswap V3 deployed on X Layer (Router: `0x5507749f2c558bb3e162c6e90c314c092e7372ff`)
- Dual-engine swap: OKX DEX Aggregator (500+ sources) + Uniswap
- 4 on-chain contracts for Agent registration, task management, and reputation
