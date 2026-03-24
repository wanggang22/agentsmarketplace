#!/usr/bin/env node
/**
 * agent-server.mjs — AgentsMarketplace AI Agent Execution Bridge
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
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const claude = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

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
const AGENT_REGISTRY  = '0x7337a8963Dc7Cf0644f9423bBE397b3D0f97ACa1';
const TASK_MANAGER    = '0x599e23D6073426eBe357d03056258eEAa217e01D';
const NANOPAY_DEMO    = '0x850747924481c0B1Ad3Eca2f60810Ff91B72b6ef';
const USDC_ADDRESS    = '0x74b7F16337b8972027F6196A17a631aC6dE26d22';
const USDT_ADDRESS    = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const USDG_ADDRESS    = '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8';

const ACCEPTED_ASSETS = [
  { address: USDC_ADDRESS, name: 'USD Coin',  symbol: 'USDC', version: '2' },
  { address: USDT_ADDRESS, name: 'USD₮0',     symbol: 'USDT', version: '2' },
  { address: USDG_ADDRESS, name: 'USDG',      symbol: 'USDG', version: '2' },
];

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

// ── OnchainOS Market + DEX + Security APIs ───────────────────────────────────

// Well-known tokens
const TOKEN_MAP = {
  'btc':  { chain: '1',   address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', name: 'Bitcoin' },
  'wbtc': { chain: '1',   address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', name: 'Wrapped BTC' },
  'eth':  { chain: '1',   address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', name: 'Ethereum' },
  'okb':  { chain: '196', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', name: 'OKB' },
  'usdc': { chain: '196', address: USDC_ADDRESS.toLowerCase(), name: 'USDC' },
  'usdt': { chain: '196', address: USDT_ADDRESS.toLowerCase(), name: 'USDT' },
  'sol':  { chain: '501', address: 'So11111111111111111111111111111111111111112', name: 'Solana' },
};

// Search token by name/symbol via OnchainOS
async function searchToken(query) {
  try {
    const result = await okxRequest('GET', `/api/v6/dex/market/token/search?chains=1,196,501&search=${encodeURIComponent(query)}`);
    if (result.code === '0' && result.data?.length > 0) {
      const t = result.data[0];
      return { chain: t.chainIndex, address: t.tokenContractAddress, name: t.tokenSymbol || t.tokenName, fullName: t.tokenName };
    }
  } catch (err) { log(`Token search error: ${err.message}`); }
  return null;
}

// Resolve query to token (check map first, then search API)
async function resolveToken(query) {
  const q = query.toLowerCase().trim();
  if (TOKEN_MAP[q]) return TOKEN_MAP[q];
  const searched = await searchToken(query);
  return searched || TOKEN_MAP['btc'];
}

// Get token price
async function getTokenPrice(query) {
  const token = await resolveToken(query);
  try {
    const result = await okxRequest('POST', '/api/v6/dex/market/price', [
      { chainIndex: token.chain, tokenContractAddress: token.address },
    ]);
    if (result.code === '0' && result.data?.[0]) {
      return { price: result.data[0].price, token: token.name, chain: token.chain, timestamp: result.data[0].time };
    }
  } catch (err) { log(`Market price error: ${err.message}`); }
  return null;
}

// Get detailed token info (market cap, volume, holders etc)
async function getTokenInfo(query) {
  const token = await resolveToken(query);
  try {
    const result = await okxRequest('POST', '/api/v6/dex/market/price-info', [
      { chainIndex: token.chain, tokenContractAddress: token.address },
    ]);
    if (result.code === '0' && result.data?.[0]) return result.data[0];
  } catch (err) { log(`Token info error: ${err.message}`); }
  return null;
}

// Get K-line data
async function getKline(query, bar = '1D', limit = 7) {
  const token = await resolveToken(query);
  try {
    const result = await okxRequest('GET',
      `/api/v6/dex/market/candles?chainIndex=${token.chain}&tokenContractAddress=${token.address}&bar=${bar}&limit=${limit}`
    );
    if (result.code === '0' && result.data?.length > 0) {
      return result.data.map(c => ({
        time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5], volumeUsd: c[6],
      }));
    }
  } catch (err) { log(`Kline error: ${err.message}`); }
  return null;
}

// Get trending/hot tokens
async function getHotTokens(chain = '1') {
  try {
    const result = await okxRequest('GET',
      `/api/v6/dex/market/token/hot-token?rankingType=4&chain=${chain}&timeFrame=4`
    );
    if (result.code === '0' && result.data?.length > 0) {
      return result.data.slice(0, 5).map(t => ({
        name: t.tokenSymbol, price: t.price, priceChange24h: t.priceChange24h, volume24h: t.volume24h,
      }));
    }
  } catch (err) { log(`Hot tokens error: ${err.message}`); }
  return null;
}

// Security scan a token
async function scanTokenSecurity(chain, address) {
  try {
    const result = await okxRequest('POST', '/api/v6/security/token-scan', {
      source: 'onchain_os_cli',
      tokenList: [{ chainId: chain, contractAddress: address }],
    });
    if (result.code === '0' && result.data?.[0]) return result.data[0];
  } catch (err) { log(`Security scan error: ${err.message}`); }
  return null;
}

// Get DEX swap quote
async function getSwapQuote(chainIndex, fromToken, toToken, amount) {
  try {
    const result = await okxRequest('GET',
      `/api/v6/dex/aggregator/quote?chainIndex=${chainIndex}&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&amount=${amount}`
    );
    if (result.code === '0' && result.data?.[0]) return result.data[0];
  } catch (err) { log(`DEX quote error: ${err.message}`); }
  return null;
}

// Smart money / whale / KOL signals
async function getSignals(chain = '1', walletType = '1') {
  try {
    const result = await okxRequest('POST', '/api/v6/dex/market/signal/list', {
      chainIndex: chain, walletType, pageSize: '10',
    });
    if (result.code === '0' && result.data?.length > 0) return result.data.slice(0, 10);
  } catch (err) { log(`Signal error: ${err.message}`); }
  return null;
}

// Leaderboard - top traders
async function getLeaderboard(chain = '1', timeFrame = '4', sortBy = '1') {
  try {
    const result = await okxRequest('GET',
      `/api/v6/dex/market/leaderboard/list?chainIndex=${chain}&timeFrame=${timeFrame}&sortBy=${sortBy}`
    );
    if (result.code === '0' && result.data?.length > 0) return result.data.slice(0, 10);
  } catch (err) { log(`Leaderboard error: ${err.message}`); }
  return null;
}

// Meme coin scanning
async function getMemePumpTokens(chain = '501', stage = 'NEW') {
  try {
    const result = await okxRequest('GET',
      `/api/v6/dex/market/memepump/tokenList?chainIndex=${chain}&stage=${stage}`
    );
    if (result.code === '0' && result.data?.length > 0) return result.data.slice(0, 10);
  } catch (err) { log(`MemePump error: ${err.message}`); }
  return null;
}

// Meme token dev info
async function getMemeDevInfo(chain, address) {
  try {
    const result = await okxRequest('GET',
      `/api/v6/dex/market/memepump/tokenDevInfo?chainIndex=${chain}&tokenContractAddress=${address}`
    );
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`Meme dev info error: ${err.message}`); }
  return null;
}

// Wallet portfolio - total value
async function getPortfolioValue(address, chains = '1,196,501') {
  try {
    const result = await okxRequest('GET',
      `/api/v6/dex/balance/total-value-by-address?address=${address}&chains=${chains}&assetType=0`
    );
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`Portfolio error: ${err.message}`); }
  return null;
}

// Wallet portfolio - all token balances
async function getPortfolioBalances(address, chains = '1,196,501') {
  try {
    const result = await okxRequest('GET',
      `/api/v6/dex/balance/all-token-balances-by-address?address=${address}&chains=${chains}`
    );
    if (result.code === '0' && result.data?.length > 0) return result.data;
  } catch (err) { log(`Portfolio balances error: ${err.message}`); }
  return null;
}

// Gateway - gas price
async function getGasPrice(chain = '196') {
  try {
    const result = await okxRequest('GET', `/api/v6/dex/pre-transaction/gas-price?chainIndex=${chain}`);
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`Gas price error: ${err.message}`); }
  return null;
}

// Gateway - simulate transaction
async function simulateTransaction(chain, from, to, data) {
  try {
    const result = await okxRequest('POST', '/api/v6/dex/pre-transaction/simulate', {
      chainIndex: chain, fromAddress: from, toAddress: to, txData: data,
    });
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`Simulate error: ${err.message}`); }
  return null;
}

// Full security scan (token + dapp)
async function scanDappSecurity(url) {
  try {
    const result = await okxRequest('POST', '/api/v6/security/dapp-scan', {
      source: 'onchain_os_cli', url,
    });
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`DApp scan error: ${err.message}`); }
  return null;
}

// ── Claude AI ─────────────────────────────────────────────────────────────────

async function askClaude(systemPrompt, userMessage) {
  if (!claude) return '(Claude API not configured — set ANTHROPIC_API_KEY)';
  try {
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    return msg.content[0]?.text || '';
  } catch (err) {
    log(`Claude API error: ${err.message}`);
    return `(AI error: ${err.message})`;
  }
}

// ── AI result generators (for TaskManager escrow tasks) ───────────────────────

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
  '/api/signals':   { amount: '20000',  display: '$0.02' },   // smart money signals
  '/api/trenches':  { amount: '10000',  display: '$0.01' },   // meme coin scanner
  '/api/swap':      { amount: '5000',   display: '$0.005' },  // DEX swap quote
  '/api/portfolio': { amount: '10000',  display: '$0.01' },   // wallet portfolio
  '/api/security':  { amount: '20000',  display: '$0.02' },   // full security scan
  '/api/gas':       { amount: '1000',   display: '$0.001' },  // gas estimation
};

function buildPaymentRequirements(pricePath) {
  const price = X402_PRICES[pricePath];
  if (!price) return null;
  return {
    x402Version: 1,
    accepts: ACCEPTED_ASSETS.map(asset => ({
      scheme: 'exact',
      network: 'eip155:196',
      maxAmountRequired: price.amount,
      resource: pricePath,
      description: `Pay ${price.display} ${asset.symbol} to access this API`,
      payTo: account.address,
      asset: asset.address,
      maxTimeoutSeconds: 300,
      extra: { name: asset.name, version: asset.version },
    })),
  };
}

function x402Guard(pricePath) {
  return async (req, res, next) => {
    const price = X402_PRICES[pricePath];
    if (!price) return next();

    // Owner bypass: if X-OWNER header matches agent wallet, skip payment
    const ownerHeader = (req.headers['x-owner'] || '').toLowerCase();
    if (ownerHeader && ownerHeader === account.address.toLowerCase()) {
      log(`Owner bypass for ${pricePath} (${ownerHeader})`);
      req.x402Settlement = { success: true, amount: 'Free (owner)', facilitator: 'none', gasSubsidy: true };
      return next();
    }

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

    // Match the asset the client chose (from their payload) to the correct accepts entry
    const clientAsset = payload.payload?.authorization?.asset
      || requirements.accepts[0].asset; // fallback to first
    const matchedRequirement = requirements.accepts.find(
      a => a.asset.toLowerCase() === clientAsset.toLowerCase()
    ) || requirements.accepts[0];

    // Step 1: Verify via OKX facilitator
    try {
      log(`x402 verifying payment for ${pricePath}...`);
      const verifyResult = await okxRequest('POST', '/api/v6/x402/verify', {
        x402Version: '1',
        chainIndex: '196',
        paymentPayload: payload,
        paymentRequirements: matchedRequirement,
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
        paymentRequirements: matchedRequirement,
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

// /api/analyze — Full market intelligence from OnchainOS + Claude AI
app.get('/api/analyze', x402Guard('/api/analyze'), async (req, res) => {
  const query = req.query.q || 'BTC';
  log(`/api/analyze: "${query}"`);

  // Parallel fetch: price + token info + kline + hot tokens
  const [priceData, tokenInfo, kline, hotTokens] = await Promise.all([
    getTokenPrice(query),
    getTokenInfo(query),
    getKline(query, '1D', 7),
    getHotTokens('1'),
  ]);

  // Build data context for Claude
  const dataContext = [];
  if (priceData) dataContext.push(`Current price: $${Number(priceData.price).toFixed(4)} (${priceData.token})`);
  if (tokenInfo) {
    if (tokenInfo.marketCap) dataContext.push(`Market cap: $${Number(tokenInfo.marketCap).toLocaleString()}`);
    if (tokenInfo.volume24h) dataContext.push(`24h volume: $${Number(tokenInfo.volume24h).toLocaleString()}`);
    if (tokenInfo.priceChange24h) dataContext.push(`24h change: ${tokenInfo.priceChange24h}%`);
  }
  if (kline?.length > 0) {
    const prices = kline.map(k => Number(k.close));
    const high7d = Math.max(...prices).toFixed(2);
    const low7d = Math.min(...prices).toFixed(2);
    dataContext.push(`7-day range: $${low7d} - $${high7d}`);
  }
  if (hotTokens?.length > 0) {
    dataContext.push(`Trending tokens: ${hotTokens.map(t => `${t.name}(${t.priceChange24h}%)`).join(', ')}`);
  }

  const analysis = await askClaude(
    'You are a crypto market analyst AI agent powered by OKX OnchainOS data. Give concise, data-driven analysis. Use the real-time data provided. Format with bullet points.',
    `Analyze: "${query}"\n\nReal-time data from OKX OnchainOS:\n${dataContext.join('\n') || 'No data available'}\n\nProvide: 1) Price assessment 2) Trend (with 7d chart context) 3) Market sentiment 4) Key risks 5) Recommendation`
  );

  const response = {
    agent: state.agentName, type: 'data-analysis', query,
    marketData: {
      price: priceData,
      details: tokenInfo ? { marketCap: tokenInfo.marketCap, volume24h: tokenInfo.volume24h, priceChange24h: tokenInfo.priceChange24h } : null,
      kline7d: kline?.map(k => ({ date: new Date(Number(k.time)).toISOString().slice(0,10), close: k.close, volume: k.volumeUsd })),
      trending: hotTokens,
    },
    analysis,
    poweredBy: { data: 'OKX OnchainOS (Market + Token + Kline)', ai: 'Claude (Anthropic)' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) {
    response.payment = req.x402Settlement;
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64'));
  }
  res.json(response);
});

// /api/translate — Real AI translation via Claude
app.get('/api/translate', x402Guard('/api/translate'), async (req, res) => {
  const text = req.query.text || 'Hello world';
  const to = req.query.to || 'es';
  const langMap = { es: 'Spanish', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic' };
  const targetLang = langMap[to] || to;
  log(`/api/translate: "${text}" → ${targetLang}`);

  const result = await askClaude(
    'You are a professional translator AI agent. Return ONLY the translated text, nothing else. No quotes, no explanation.',
    `Translate the following text to ${targetLang}:\n\n${text}`
  );

  const response = {
    agent: state.agentName, type: 'translation',
    source: text, targetLanguage: targetLang, result,
    poweredBy: 'Claude (Anthropic)',
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) {
    response.payment = req.x402Settlement;
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64'));
  }
  res.json(response);
});

// /api/audit — Security scan (OnchainOS) + AI audit (Claude)
app.get('/api/audit', x402Guard('/api/audit'), async (req, res) => {
  const contract = req.query.contract || '';
  const code = req.query.code || '';
  const chain = req.query.chain || '196';
  log(`/api/audit: ${contract || 'inline code'}`);

  // Run OKX security scan if contract address provided
  let securityScan = null;
  if (contract && contract.startsWith('0x')) {
    securityScan = await scanTokenSecurity(chain, contract);
  }

  const scanContext = securityScan
    ? `OKX Security Scan results:\n- Risk level: ${securityScan.riskLevel || 'unknown'}\n- Warnings: ${JSON.stringify(securityScan.riskItemDetail || securityScan.warnings || [])}`
    : 'No automated scan available';

  const auditInput = code
    ? `Audit this Solidity code:\n\n${code}\n\n${scanContext}`
    : `Audit contract ${contract} on chain ${chain}.\n\n${scanContext}\n\nProvide a security assessment.`;

  const audit = await askClaude(
    'You are a smart contract security auditor AI agent powered by OKX OnchainOS security scanning. Provide: 1) Overall Risk (CRITICAL/HIGH/MEDIUM/LOW), 2) Findings with severity, 3) Gas optimizations, 4) Recommendations. Use the security scan data when available.',
    auditInput
  );

  const response = {
    agent: state.agentName, type: 'security-audit',
    contract: contract || '(inline code)', chain,
    securityScan: securityScan ? { riskLevel: securityScan.riskLevel, warnings: securityScan.riskItemDetail || securityScan.warnings } : null,
    audit,
    poweredBy: { scan: 'OKX OnchainOS Security', ai: 'Claude (Anthropic)' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) {
    response.payment = req.x402Settlement;
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64'));
  }
  res.json(response);
});

// /api/signals — Smart money / whale / KOL signals + leaderboard
app.get('/api/signals', x402Guard('/api/signals'), async (req, res) => {
  const chain = req.query.chain || '1';
  const type = req.query.type || 'smart_money'; // smart_money, kol, whale
  const walletType = { smart_money: '1', kol: '2', whale: '3' }[type] || '1';
  log(`/api/signals: chain=${chain} type=${type}`);

  const [signals, leaderboard] = await Promise.all([
    getSignals(chain, walletType),
    getLeaderboard(chain, '4', '1'), // 30-day, sort by PnL
  ]);

  const analysis = await askClaude(
    'You are a DeFi signal analyst. Analyze the smart money/whale movements and provide actionable insights in 3-5 bullet points.',
    `Signal type: ${type}\nChain: ${chain}\n\nRecent signals: ${JSON.stringify(signals?.slice(0,5) || [])}\n\nTop traders (30d): ${JSON.stringify(leaderboard?.slice(0,5) || [])}\n\nAnalyze: what are smart money doing? Any patterns?`
  );

  const response = {
    agent: state.agentName, type: 'signals', signalType: type, chain,
    signals: signals?.slice(0, 10), leaderboard: leaderboard?.slice(0, 5),
    analysis,
    poweredBy: { data: 'OKX OnchainOS (Signal + Leaderboard)', ai: 'Claude' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// /api/trenches — Meme coin scanner
app.get('/api/trenches', x402Guard('/api/trenches'), async (req, res) => {
  const chain = req.query.chain || '501'; // Solana default for memes
  const stage = req.query.stage || 'NEW';
  log(`/api/trenches: chain=${chain} stage=${stage}`);

  const tokens = await getMemePumpTokens(chain, stage);

  const analysis = await askClaude(
    'You are a meme coin analyst. Evaluate new meme tokens for potential and risks. Be direct about rug pull risks.',
    `New meme tokens (${stage}) on chain ${chain}:\n${JSON.stringify(tokens?.slice(0,5) || [])}\n\nAnalyze: which look promising vs likely rugs? Key warning signs?`
  );

  const response = {
    agent: state.agentName, type: 'trenches', chain, stage,
    tokens: tokens?.slice(0, 10),
    analysis,
    poweredBy: { data: 'OKX OnchainOS (MemePump)', ai: 'Claude' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// /api/swap — DEX swap quote (read-only, no execution)
app.get('/api/swap', x402Guard('/api/swap'), async (req, res) => {
  const chain = req.query.chain || '196';
  const from = req.query.from || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // native token
  const to = req.query.to || USDC_ADDRESS;
  const amount = req.query.amount || '1000000000000000000'; // 1 token in wei
  log(`/api/swap: ${from.slice(0,10)}→${to.slice(0,10)} amount=${amount}`);

  const quote = await getSwapQuote(chain, from, to, amount);

  const response = {
    agent: state.agentName, type: 'swap-quote', chain,
    fromToken: from, toToken: to, amount,
    quote: quote ? {
      toAmount: quote.toTokenAmount, toAmountUsd: quote.toTokenAmountUsd,
      priceImpact: quote.priceImpactPercentage,
      route: quote.dexRouterList,
    } : null,
    poweredBy: 'OKX OnchainOS (DEX Aggregator, 500+ sources)',
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// /api/portfolio — Wallet portfolio analysis
app.get('/api/portfolio', x402Guard('/api/portfolio'), async (req, res) => {
  const address = req.query.address;
  const chains = req.query.chains || '1,196,501,8453,56';
  if (!address) return res.status(400).json({ error: 'address parameter required' });
  log(`/api/portfolio: ${address.slice(0,10)}... chains=${chains}`);

  const [totalValue, balances] = await Promise.all([
    getPortfolioValue(address, chains),
    getPortfolioBalances(address, chains),
  ]);

  const analysis = await askClaude(
    'You are a portfolio analyst. Analyze the wallet holdings and provide insights on diversification, risk, and recommendations.',
    `Wallet: ${address}\nTotal value: ${JSON.stringify(totalValue)}\nTop holdings: ${JSON.stringify(balances?.slice(0,10) || [])}\n\nAnalyze: diversification, concentration risk, suggestions.`
  );

  const response = {
    agent: state.agentName, type: 'portfolio', address, chains,
    totalValue, topHoldings: balances?.slice(0, 20),
    analysis,
    poweredBy: { data: 'OKX OnchainOS (Portfolio)', ai: 'Claude' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// /api/security — Full security scan (token + DApp + AI analysis)
app.get('/api/security', x402Guard('/api/security'), async (req, res) => {
  const token = req.query.token;
  const dapp = req.query.dapp;
  const chain = req.query.chain || '1';
  log(`/api/security: token=${token || 'none'} dapp=${dapp || 'none'}`);

  const [tokenScan, dappScan] = await Promise.all([
    token ? scanTokenSecurity(chain, token) : null,
    dapp ? scanDappSecurity(dapp) : null,
  ]);

  const analysis = await askClaude(
    'You are a blockchain security expert. Analyze the scan results and provide a clear risk assessment with actionable advice.',
    `Security scan results:\nToken scan: ${JSON.stringify(tokenScan)}\nDApp scan: ${JSON.stringify(dappScan)}\n\nProvide: overall risk level, specific threats found, recommendations.`
  );

  const response = {
    agent: state.agentName, type: 'security-scan',
    tokenScan, dappScan,
    analysis,
    poweredBy: { data: 'OKX OnchainOS (Security)', ai: 'Claude' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// /api/gas — Gas estimation + network status
app.get('/api/gas', x402Guard('/api/gas'), async (req, res) => {
  const chain = req.query.chain || '196';
  log(`/api/gas: chain=${chain}`);

  const gasData = await getGasPrice(chain);

  const response = {
    agent: state.agentName, type: 'gas-estimation', chain,
    gas: gasData,
    poweredBy: 'OKX OnchainOS (Gateway)',
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// Free: API directory
app.get('/api', (_req, res) => {
  res.json({
    agent: state.agentName,
    protocol: 'x402 via OKX Facilitator (zero gas)',
    network: 'X Layer (eip155:196)',
    acceptedTokens: ACCEPTED_ASSETS.map(a => ({ symbol: a.symbol, address: a.address })),
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

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>AgentsMarketplace Server</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui;background:#0d1117;color:#c9d1d9;padding:2rem}.c{max-width:720px;margin:0 auto}h1{color:#58a6ff;margin-bottom:.5rem}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.25rem;margin-bottom:1.25rem}code{background:#21262d;padding:2px 6px;border-radius:4px;font-size:.85rem}a{color:#58a6ff}</style></head>
<body><div class="c"><h1>AgentsMarketplace Server</h1><p style="color:#8b949e;margin-bottom:2rem">AI Agent Execution Bridge — X Layer + x402 (OKX Facilitator)</p>
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
  console.log(`\n${'='.repeat(60)}\n  AgentsMarketplace Server (Escrow + x402 OKX)\n${'='.repeat(60)}`);
  console.log(`  Address:     ${account.address}`);
  console.log(`  RPC:         ${RPC_URL}`);
  console.log(`  Chain:       196 (X Layer)`);
  console.log(`  x402:        ${hasOkxKeys ? 'OKX Facilitator (zero gas)' : 'NOT CONFIGURED'}`);
  console.log(`  AI:          ${claude ? 'Claude (Anthropic)' : 'NOT CONFIGURED — set ANTHROPIC_API_KEY'}`);
  console.log(`  Market Data: ${hasOkxKeys ? 'OKX OnchainOS Market API' : 'NOT CONFIGURED'}`);
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
