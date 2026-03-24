#!/usr/bin/env node
/**
 * agent-server.mjs — XLayerAgent AI Agent Execution Bridge
 *
 * Two payment modes:
 *   1. On-chain escrow (TaskManager) — for large tasks ($0.1+)
 *   2. x402 micropayments via OKX native facilitator — zero gas, USDC payments
 *      Caller signs EIP-3009 off-chain, OKX settles on-chain and pays gas.
 *
 * Usage:
 *   AGENT_PK=0x... node scripts/agent-server.mjs
 *
 * Environment:
 *   AGENT_PK           — agent wallet private key
 *   OKX_API_KEY        — OKX API key for x402 facilitator
 *   OKX_SECRET_KEY     — OKX secret key
 *   OKX_PASSPHRASE     — OKX passphrase
 *   PORT               — HTTP port (default 3080)
 *   POLL_MS            — task-poll interval in ms (default 5000)
 */

import {
  createPublicClient, createWalletClient, http, defineChain, parseAbi, formatUnits, keccak256, toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import express from 'express';
import crypto from 'crypto';

const PORT    = Number(process.env.PORT) || 3080;
const POLL_MS = Number(process.env.POLL_MS) || 5000;

const AGENT_PK = process.env.AGENT_PK;
if (!AGENT_PK) { console.error('Set AGENT_PK environment variable.'); process.exit(1); }

// OKX API credentials for x402 facilitator
const OKX_API_KEY    = process.env.OKX_API_KEY    || '';
const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY || '';
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE || '';
const OKX_BASE_URL   = 'https://web3.okx.com';

const RPC_URL         = 'https://rpc.xlayer.tech';
const AGENT_REGISTRY  = '0xBeA9d2d1766C2E9498334D45C479046c28F49Ae2';
const TASK_MANAGER    = '0x77B5A2Ab2dc74A5f9892e7e18c96B05cbd822D08';
const NANOPAY_DEMO    = '0x2e6C48b3240ab6fED223B73b3903976C1D899B42';
const USDC_ADDRESS    = '0x74b7F16337b8972027F6196A17a631aC6dE26d22';

const xLayer = defineChain({
  id: 196, name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const registryAbi = parseAbi([
  'function isRegistered(address) view returns (bool)',
  'function getAgent(address) view returns ((string name,string description,string endpoint,uint256 pricePerTask,string[] skillTags,bool active,uint256 registeredAt,uint256 totalTasks,uint256 totalEarned))',
]);

const taskManagerAbi = parseAbi([
  'function getTaskCount() view returns (uint256)',
  'function getTask(uint256 taskId) view returns ((address client,address agent,string description,uint256 payment,string resultHash,uint8 state,uint256 createdAt,uint256 acceptedAt,uint256 completedAt,uint256 disputedAt))',
  'function acceptTask(uint256 taskId)',
  'function completeTask(uint256 taskId,string resultHash)',
]);

const nanopayAbi = parseAbi([
  'function recordPayment(address agent,uint256 amount,string taskType)',
]);

const account = privateKeyToAccount(AGENT_PK);
const publicClient = createPublicClient({ chain: xLayer, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: xLayer, transport: http(RPC_URL) });

const state = {
  agentName: '(loading...)', agentAddress: account.address,
  status: 'starting', tasksProcessed: 0, totalEarned: 0n,
  x402Calls: 0, x402Earned: 0n,
  recentLogs: [], lastKnownTaskCount: 0n,
  startedAt: new Date(), processing: new Set(),
};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  state.recentLogs.push(entry);
  if (state.recentLogs.length > 20) state.recentLogs.shift();
}

// ── OKX API helper ────────────────────────────────────────────────────────────

function okxSign(method, path, body) {
  const timestamp = new Date().toISOString();
  const prehash = timestamp + method + path + (body || '');
  const sign = crypto.createHmac('sha256', OKX_SECRET_KEY).update(prehash).digest('base64');
  return {
    'OK-ACCESS-KEY': OKX_API_KEY,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'Content-Type': 'application/json',
  };
}

async function okxRequest(method, path, body) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = okxSign(method, path, bodyStr);
  const res = await fetch(OKX_BASE_URL + path, {
    method,
    headers,
    ...(method === 'POST' ? { body: bodyStr } : {}),
  });
  return res.json();
}

const hasOkxKeys = OKX_API_KEY && OKX_SECRET_KEY && OKX_PASSPHRASE;

// ── AI result generators ──────────────────────────────────────────────────────

function classifyTask(d) {
  const l = d.toLowerCase();
  if (l.includes('audit') || l.includes('security') || l.includes('review')) return 'security-audit';
  if (l.includes('translate')) return 'translation';
  if (l.includes('analyze') || l.includes('data')) return 'data-analysis';
  return 'general';
}

function generateResult(description, taskType) {
  const results = {
    'security-audit': { type: 'security-audit', summary: 'Audit completed.', overallRisk: 'LOW', findings: [] },
    'translation': { type: 'translation', summary: 'Translation completed.', confidence: 0.96 },
    'data-analysis': { type: 'data-analysis', summary: 'Analysis completed.', confidence: 0.91 },
    'general': { type: 'task-completion', summary: `Completed: "${description.slice(0, 100)}"`, status: 'done' },
  };
  return JSON.stringify(results[taskType] || results.general);
}

// ── On-chain tx helper ────────────────────────────────────────────────────────

async function sendTx(params, label) {
  log(`  TX: ${label}...`);
  try {
    const hash = await walletClient.writeContract(params);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    log(`  TX confirmed (block ${receipt.blockNumber})`);
    return receipt;
  } catch (err) {
    log(`  TX FAILED: ${err.shortMessage || err.message}`);
    throw err;
  }
}

// ── TaskManager polling (escrow tasks) ────────────────────────────────────────

async function processTask(taskId) {
  if (state.processing.has(taskId)) return;
  state.processing.add(taskId);
  try {
    const task = await publicClient.readContract({ address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'getTask', args: [taskId] });
    if (task.agent.toLowerCase() !== account.address.toLowerCase()) return;
    if (task.state !== 0) return;

    log(`New task #${taskId}: ${task.description.slice(0, 80)}`);
    await sendTx({ address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'acceptTask', args: [taskId] }, `acceptTask(${taskId})`);

    const taskType = classifyTask(task.description);
    const delay = 3000 + Math.floor(Math.random() * 2000);
    log(`  Processing as "${taskType}" (${delay}ms)...`);
    await new Promise((r) => setTimeout(r, delay));

    const resultBody = generateResult(task.description, taskType);
    const resultHash = keccak256(toHex(resultBody)).slice(0, 50);
    await sendTx({ address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'completeTask', args: [taskId, resultHash] }, `completeTask(${taskId})`);

    try {
      await sendTx({ address: NANOPAY_DEMO, abi: nanopayAbi, functionName: 'recordPayment', args: [account.address, task.payment, taskType] }, 'recordPayment');
    } catch { /* non-fatal */ }

    state.tasksProcessed += 1;
    state.totalEarned += task.payment;
    log(`Task ${taskId} completed!`);
  } catch (err) {
    log(`Error on task ${taskId}: ${err.shortMessage || err.message}`);
  } finally {
    state.processing.delete(taskId);
  }
}

let pollTimer = null;
let consecutiveErrors = 0;

async function poll() {
  try {
    const taskCount = await publicClient.readContract({ address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'getTaskCount' });
    consecutiveErrors = 0;
    if (taskCount > state.lastKnownTaskCount) {
      for (let id = state.lastKnownTaskCount; id < taskCount; id++) processTask(id);
      state.lastKnownTaskCount = taskCount;
    }
  } catch (err) {
    consecutiveErrors += 1;
    const backoff = Math.min(consecutiveErrors * 5, 60);
    log(`RPC error: ${err.shortMessage || err.message}. Retrying in ${backoff}s.`);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, backoff * 1000);
    return;
  }
  pollTimer = setTimeout(poll, POLL_MS);
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── x402 Payment via OKX Facilitator ──────────────────────────────────────────

const X402_PRICES = {
  '/api/analyze':   { amount: '10000',  display: '$0.01' },   // 0.01 USDC
  '/api/translate': { amount: '5000',   display: '$0.005' },  // 0.005 USDC
  '/api/audit':     { amount: '50000',  display: '$0.05' },   // 0.05 USDC
};

function buildPaymentRequirements(pricePath) {
  const price = X402_PRICES[pricePath];
  if (!price) return null;
  return {
    x402Version: 1,
    accepts: [{
      scheme: 'exact',
      network: 'eip155:196',
      maxAmountRequired: price.amount,
      resource: pricePath,
      description: `Pay ${price.display} USDC to access this API`,
      payTo: account.address,
      asset: USDC_ADDRESS,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    }],
  };
}

function x402Guard(pricePath) {
  return async (req, res, next) => {
    const price = X402_PRICES[pricePath];
    if (!price) return next();

    const paymentHeader = req.headers['payment-signature'] || req.headers['x-payment'];

    if (!paymentHeader) {
      const requirements = buildPaymentRequirements(pricePath);
      const encoded = Buffer.from(JSON.stringify(requirements)).toString('base64');
      res.setHeader('PAYMENT-REQUIRED', encoded);
      return res.status(402).json(requirements);
    }

    // Parse payment payload
    let payload;
    try {
      payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
    } catch {
      return res.status(400).json({ error: 'Invalid PAYMENT-SIGNATURE: not valid base64 JSON' });
    }

    const requirements = buildPaymentRequirements(pricePath);

    if (!hasOkxKeys) {
      return res.status(500).json({ error: 'x402 facilitator not configured (missing OKX API keys)' });
    }

    // Step 1: Verify via OKX facilitator
    try {
      log(`x402 verifying payment for ${pricePath}...`);
      const verifyResult = await okxRequest('POST', '/api/v6/x402/verify', {
        x402Version: '1',
        chainIndex: '196',
        paymentPayload: payload,
        paymentRequirements: requirements.accepts[0],
      });

      if (verifyResult.code !== '0' || !verifyResult.data?.[0]?.isValid) {
        const reason = verifyResult.data?.[0]?.invalidReason || verifyResult.msg || 'unknown';
        log(`x402 verify failed: ${reason}`);
        return res.status(402).json({
          error: 'Payment verification failed',
          reason,
          ...requirements,
        });
      }

      const payer = verifyResult.data[0].payer;
      log(`x402 verified! Payer: ${payer}`);

      // Step 2: Settle via OKX facilitator (zero gas — OKX pays)
      log(`x402 settling via OKX facilitator...`);
      const settleResult = await okxRequest('POST', '/api/v6/x402/settle', {
        x402Version: '1',
        chainIndex: '196',
        syncSettle: true,
        paymentPayload: payload,
        paymentRequirements: requirements.accepts[0],
      });

      if (settleResult.code !== '0' || !settleResult.data?.[0]?.success) {
        const reason = settleResult.data?.[0]?.errorMsg || settleResult.msg || 'settlement failed';
        log(`x402 settle failed: ${reason}`);
        return res.status(402).json({ error: 'Payment settlement failed', reason });
      }

      const txHash = settleResult.data[0].txHash;
      log(`x402 settled! tx: ${txHash} (gas paid by OKX)`);

      req.x402Settlement = {
        success: true,
        transaction: txHash,
        network: 'eip155:196',
        payer,
        amount: price.display,
        facilitator: 'OKX x402',
        gasSubsidy: true,
      };

      state.x402Calls++;
      state.x402Earned += BigInt(price.amount);

      next();
    } catch (err) {
      log(`x402 error: ${err.message}`);
      return res.status(500).json({ error: 'x402 facilitator error', message: err.message });
    }
  };
}

// ── API Endpoints ─────────────────────────────────────────────────────────────

app.get('/api/analyze', x402Guard('/api/analyze'), (req, res) => {
  const query = req.query.q || 'general market data';
  log(`/api/analyze: "${query}"`);
  const response = {
    agent: state.agentName, type: 'data-analysis', query,
    result: {
      summary: `Analysis of "${query}" completed.`,
      dataPoints: Math.floor(Math.random() * 5000) + 1000,
      trend: 'upward', confidence: 0.92,
      insights: ['Primary metric shows 12% growth.', 'Seasonal pattern detected with Q4 peak.'],
    },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) {
    response.payment = req.x402Settlement;
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64'));
  }
  res.json(response);
});

app.get('/api/translate', x402Guard('/api/translate'), (req, res) => {
  const text = req.query.text || 'Hello world';
  const to = req.query.to || 'es';
  log(`/api/translate: "${text}" → ${to}`);
  const translations = { es: 'Hola mundo', zh: '你好世界', ja: 'こんにちは世界', ko: '안녕하세요 세계', fr: 'Bonjour le monde' };
  const response = {
    agent: state.agentName, type: 'translation',
    source: text, target: to, result: translations[to] || `[${to}] ${text}`,
    confidence: 0.96, timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) {
    response.payment = req.x402Settlement;
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64'));
  }
  res.json(response);
});

app.get('/api/audit', x402Guard('/api/audit'), (req, res) => {
  const contract = req.query.contract || '0x0000000000000000000000000000000000000000';
  log(`/api/audit: ${contract}`);
  const response = {
    agent: state.agentName, type: 'security-audit', contract,
    result: {
      overallRisk: 'LOW',
      findings: [
        { severity: 'INFO', title: 'Floating pragma', recommendation: 'Pin solidity version.' },
        { severity: 'LOW', title: 'Missing event on state change', recommendation: 'Add events.' },
      ],
      gasOptimizations: ['Cache storage reads in loops.'],
      conclusion: 'No critical issues found.',
    },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) {
    response.payment = req.x402Settlement;
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64'));
  }
  res.json(response);
});

// Free: API directory
app.get('/api', (_req, res) => {
  res.json({
    agent: state.agentName,
    protocol: 'x402 via OKX Facilitator (zero gas)',
    network: 'X Layer (eip155:196)',
    usdc: USDC_ADDRESS,
    payTo: account.address,
    facilitator: 'OKX OnchainOS',
    gasSubsidy: 'OKX pays all settlement gas fees',
    endpoints: Object.entries(X402_PRICES).map(([path, p]) => ({
      method: 'GET', path, price: p.display, priceRaw: p.amount,
    })),
    howToPay: {
      step1: 'GET the endpoint without payment → receive 402 + PAYMENT-REQUIRED header',
      step2: 'Sign a transferWithAuthorization (EIP-3009) for the required USDC amount',
      step3: 'Re-send request with PAYMENT-SIGNATURE header (base64 encoded payload)',
      step4: 'OKX facilitator verifies + settles on-chain (zero gas for you)',
      step5: 'Receive 200 + result + PAYMENT-RESPONSE header with txHash',
    },
  });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  const uptime = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
  const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;
  const earned = formatUnits(state.totalEarned, 6);
  const x402Earned = formatUnits(state.x402Earned, 6);
  const statusColor = state.status === 'listening' ? '#00e676' : '#ffa726';
  const okxStatus = hasOkxKeys ? '<span style="color:#00e676">connected</span>' : '<span style="color:#ef4444">no API keys</span>';
  const logsHtml = state.recentLogs.length
    ? state.recentLogs.map((l) => `<div style="font-family:monospace;font-size:.8rem;padding:4px 0;border-bottom:1px solid #21262d">${escapeHtml(l)}</div>`).join('')
    : '<div style="color:#484f58">No activity yet.</div>';

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>XLayerAgent Server</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui;background:#0d1117;color:#c9d1d9;padding:2rem}.c{max-width:720px;margin:0 auto}h1{color:#58a6ff;margin-bottom:.5rem}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.25rem;margin-bottom:1.25rem}code{background:#21262d;padding:2px 6px;border-radius:4px;font-size:.85rem}a{color:#58a6ff}</style></head>
<body><div class="c"><h1>XLayerAgent Server</h1><p style="color:#8b949e;margin-bottom:2rem">AI Agent Execution Bridge — X Layer + x402 (OKX Facilitator)</p>
<div class="card"><b>${escapeHtml(state.agentName)}</b> <span style="color:${statusColor}">${state.status}</span><br><code>${state.agentAddress}</code></div>
<div class="card"><b>On-chain Escrow</b><br>Tasks: ${state.tasksProcessed} | Earned: ${earned} USDC</div>
<div class="card"><b>x402 Micropayments</b> — OKX Facilitator: ${okxStatus}<br>Calls: ${state.x402Calls} | Earned: ${x402Earned} USDC | Gas: <span style="color:#00e676">$0 (OKX subsidy)</span><br><br>
<code>GET /api/analyze</code> $0.01 &nbsp; <code>GET /api/translate</code> $0.005 &nbsp; <code>GET /api/audit</code> $0.05<br><br>
<a href="/api">GET /api</a> — endpoint list + payment instructions (free)</div>
<div class="card"><b>Activity</b> | Uptime: ${uptimeStr}<br>${logsHtml}</div>
<p style="text-align:center;color:#484f58;margin-top:2rem">X Layer (chain 196) | x402 via OKX | USDC zero-gas settlement</p></div></body></html>`);
});

app.get('/status', (_req, res) => {
  res.json({
    agent: state.agentName, address: state.agentAddress, status: state.status,
    tasksProcessed: state.tasksProcessed, totalEarned: formatUnits(state.totalEarned, 6),
    x402Calls: state.x402Calls, x402Earned: formatUnits(state.x402Earned, 6),
    facilitator: hasOkxKeys ? 'OKX (connected)' : 'not configured',
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function start() {
  console.log(`\n${'='.repeat(60)}\n  XLayerAgent Server (Escrow + x402 OKX)\n${'='.repeat(60)}`);
  console.log(`  Address:     ${account.address}`);
  console.log(`  RPC:         ${RPC_URL}`);
  console.log(`  Chain:       196 (X Layer)`);
  console.log(`  x402:        ${hasOkxKeys ? 'OKX Facilitator (zero gas)' : 'NOT CONFIGURED — set OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE'}`);
  console.log(`  Dashboard:   http://localhost:${PORT}\n`);

  try {
    const isReg = await publicClient.readContract({ address: AGENT_REGISTRY, abi: registryAbi, functionName: 'isRegistered', args: [account.address] });
    if (isReg) {
      const info = await publicClient.readContract({ address: AGENT_REGISTRY, abi: registryAbi, functionName: 'getAgent', args: [account.address] });
      state.agentName = info.name;
      log(`Registered as "${info.name}"`);
    } else {
      state.agentName = '(unregistered)';
      log('WARNING: Agent not registered.');
    }
  } catch (err) { log(`Registration check failed: ${err.message}`); }

  if (hasOkxKeys) {
    try {
      const supported = await okxRequest('GET', '/api/v6/x402/supported');
      log(`OKX x402 facilitator: ${JSON.stringify(supported.data)}`);
    } catch (err) { log(`OKX facilitator check failed: ${err.message}`); }
  }

  state.status = 'listening';
  log('Listening for escrow tasks + x402 API calls...');
  pollTimer = setTimeout(poll, POLL_MS);
  app.listen(PORT, () => log(`Dashboard at http://localhost:${PORT}`));
}

process.on('SIGINT', () => { clearTimeout(pollTimer); process.exit(0); });
process.on('SIGTERM', () => { clearTimeout(pollTimer); process.exit(0); });

start().catch((err) => { console.error('[FATAL]', err.message); process.exit(1); });
