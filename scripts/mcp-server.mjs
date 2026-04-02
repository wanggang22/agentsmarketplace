#!/usr/bin/env node
/**
 * mcp-server.mjs — MCP Server for AgentsMarketplace
 *
 * Exposes the marketplace's AI Agent capabilities as MCP tools.
 * Any AI Agent (Claude Code, Cursor, etc.) can install this and call our services.
 *
 * Protocol: JSON-RPC 2.0 over stdio
 * Usage: node scripts/mcp-server.mjs
 *
 * For Skills Arena submission: this makes AgentsMarketplace a reusable Skill.
 */

import { createInterface } from 'readline';

// ── Configuration ───────────────────────────────────────────────────────────

const AGENT_BASE_URL = process.env.AGENT_URL || 'https://xlayeragent-server-production.up.railway.app';

// ── MCP Tool Definitions ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'marketplace_ask',
    description: 'Ask the AgentsMarketplace AI Agent any question about crypto, DeFi, or X Layer. The Agent uses 20+ tools (market data, signals, security, DeFi, Uniswap) to answer. Requires x402 payment ($0.02 USDC).',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Your question (e.g. "What is the best yield for USDC on X Layer?")' },
      },
      required: ['question'],
    },
  },
  {
    name: 'marketplace_analyze',
    description: 'Get AI-powered market analysis for any token. Returns real-time price, K-line trends, and AI insights. Requires x402 payment ($0.01 USDC).',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token name or symbol (e.g. BTC, ETH, OKB)' },
      },
      required: ['token'],
    },
  },
  {
    name: 'marketplace_dual_swap',
    description: 'Compare swap quotes from OKX DEX Aggregator vs Uniswap on X Layer. Returns which engine gives better price. Requires x402 payment ($0.01 USDC).',
    inputSchema: {
      type: 'object',
      properties: {
        from_token: { type: 'string', description: 'Input token address on X Layer' },
        to_token: { type: 'string', description: 'Output token address on X Layer' },
        amount: { type: 'string', description: 'Amount in minimal units (wei)' },
      },
      required: ['from_token', 'to_token', 'amount'],
    },
  },
  {
    name: 'marketplace_signals',
    description: 'Get smart money / whale / KOL trading signals and top trader leaderboard. Requires x402 payment ($0.01 USDC).',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'Chain index: "1" ETH, "196" X Layer, "501" Solana. Default "1"' },
      },
      required: [],
    },
  },
  {
    name: 'marketplace_security',
    description: 'Scan a token for security risks (honeypot, rug pull, high tax). Requires x402 payment ($0.01 USDC).',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token name, symbol, or contract address' },
        chain: { type: 'string', description: 'Chain index, default "196"' },
      },
      required: ['token'],
    },
  },
  {
    name: 'marketplace_defi',
    description: 'Search DeFi yield products on X Layer and other chains. Returns best APY opportunities from Aave, Uniswap LP, Lido, etc. Requires x402 payment ($0.01 USDC).',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token symbol (e.g. USDC, ETH)' },
        chain: { type: 'string', description: 'Chain index, default "196"' },
      },
      required: [],
    },
  },
  {
    name: 'marketplace_portfolio',
    description: 'Analyze wallet holdings and portfolio value across 20+ chains. Requires x402 payment ($0.01 USDC).',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address (0x...)' },
      },
      required: ['address'],
    },
  },
  {
    name: 'marketplace_strategy',
    description: 'Execute a multi-step AI strategy (signal-to-trade, yield optimization, portfolio rebalance). Premium feature. Requires x402 payment ($0.05 USDC).',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Strategy goal (e.g. "Find the best yield for 1000 USDC on X Layer")' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'marketplace_economic_loop',
    description: 'Demonstrate the Agent economic loop: earn→analyze→invest→pay→re-earn. Shows how Agents create value on X Layer. Requires x402 payment ($0.02 USDC).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ── Tool Execution ──────────────────────────────────────────────────────────

const TOOL_TO_ENDPOINT = {
  marketplace_ask:           (args) => `/api/ask?q=${encodeURIComponent(args.question)}`,
  marketplace_analyze:       (args) => `/api/analyze?q=${encodeURIComponent(args.token)}`,
  marketplace_dual_swap:     (args) => `/api/dual-swap?from=${args.from_token}&to=${args.to_token}&amount=${args.amount}`,
  marketplace_signals:       (args) => `/api/signals?chain=${args.chain || '1'}`,
  marketplace_security:      (args) => `/api/security?q=${encodeURIComponent(args.token)}&chain=${args.chain || '196'}`,
  marketplace_defi:          (args) => `/api/defi?token=${encodeURIComponent(args.token || 'USDC')}&chain=${args.chain || '196'}`,
  marketplace_portfolio:     (args) => `/api/portfolio?address=${args.address}`,
  marketplace_strategy:      (args) => `/api/strategy?q=${encodeURIComponent(args.goal)}`,
  marketplace_economic_loop: ()     => `/api/economic-loop`,
};

async function executeTool(name, args) {
  const pathFn = TOOL_TO_ENDPOINT[name];
  if (!pathFn) return { error: `Unknown tool: ${name}` };

  const url = AGENT_BASE_URL + pathFn(args);

  try {
    // First request — may return 402
    let res = await fetch(url);

    if (res.status === 402) {
      // In production, this would auto-pay via x402.
      // For demo, return the payment requirements so the calling Agent can pay.
      const body = await res.text();
      let requirements;
      try {
        const header = res.headers.get('PAYMENT-REQUIRED') || res.headers.get('payment-required');
        requirements = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf-8')) : JSON.parse(body);
      } catch { requirements = body; }

      return {
        status: 'payment_required',
        message: `This endpoint requires x402 micropayment. Send a PAYMENT-SIGNATURE header to access.`,
        requirements,
        endpoint: url,
        howToPay: 'Sign EIP-3009 TransferWithAuthorization for the required amount, encode as base64, and send as PAYMENT-SIGNATURE header.',
      };
    }

    const data = await res.json();
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

// ── JSON-RPC over stdio ─────────────────────────────────────────────────────

const SERVER_INFO = {
  name: 'agentsmarketplace',
  version: '2.0.0',
  description: 'AI Agent Service Marketplace on X Layer — 20+ tools, x402 micropayments, OKX + Uniswap dual engine',
};

function handleRequest(request) {
  const { method, params, id } = request;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const { name, arguments: args } = params;
      // Return a promise — handled in the message loop
      return executeTool(name, args || {}).then(result => ({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      }));
    }

    case 'notifications/initialized':
      return null; // No response for notifications

    default:
      return {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ── stdio transport ─────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });
let buffer = '';

process.stdin.on('data', async (chunk) => {
  buffer += chunk.toString();

  // Process complete JSON-RPC messages (newline-delimited)
  const lines = buffer.split('\n');
  buffer = lines.pop(); // Keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line);
      const response = handleRequest(request);

      if (response === null) continue; // Notification, no response

      // Handle async (tools/call returns a Promise)
      const resolved = await response;
      if (resolved) {
        process.stdout.write(JSON.stringify(resolved) + '\n');
      }
    } catch (err) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: `Parse error: ${err.message}` },
      }) + '\n');
    }
  }
});

process.stderr.write(`[mcp-server] AgentsMarketplace MCP Server started\n`);
process.stderr.write(`[mcp-server] Agent URL: ${AGENT_BASE_URL}\n`);
process.stderr.write(`[mcp-server] Tools: ${TOOLS.length}\n`);
