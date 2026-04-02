#!/usr/bin/env node
/**
 * agent-server.mjs — AgentsMarketplace AI Agent Execution Bridge
 *
 * Payment: x402 micropayments via OKX native facilitator
 *   - Zero gas for callers (OKX pays settlement gas)
 *   - Supports USDC, USDT, USDG on X Layer
 *   - Caller signs EIP-3009 off-chain, OKX settles on-chain
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
  createPublicClient, createWalletClient, http, defineChain, parseAbi, formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import express from 'express';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { buildSkillPrompt } from './skills-loader.mjs';
import { initAgenticWallet, x402Pay, walletBalance, walletSend, swapExecute, isAvailable as agenticWalletAvailable } from './agentic-wallet.mjs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const claude = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Uniswap Trading API
const UNISWAP_API_KEY = process.env.UNISWAP_API_KEY || '';
const UNISWAP_BASE_URL = 'https://trade-api.gateway.uniswap.org/v1';

// Load Skill-driven system prompt at startup
let SKILL_SYSTEM_PROMPT = '';
try {
  SKILL_SYSTEM_PROMPT = buildSkillPrompt();
} catch (err) {
  console.warn('[skills-loader] Failed to load skills, using fallback prompt:', err.message);
  SKILL_SYSTEM_PROMPT = 'You are a full-stack AI agent on X Layer with access to real-time blockchain data from OKX OnchainOS and Uniswap. Use the available tools to gather data, then provide a clear, comprehensive answer. Be specific with numbers. IMPORTANT: Reply in the same language as the user\'s question.';
}

const PORT = Number(process.env.PORT) || 3080;

const AGENT_PK = process.env.AGENT_PK;
if (!AGENT_PK) { console.error('Set AGENT_PK environment variable.'); process.exit(1); }

// OKX API credentials for x402 facilitator
const OKX_API_KEY    = process.env.OKX_API_KEY    || '';
const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY || '';
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE || '';
const OKX_BASE_URL   = 'https://web3.okx.com';

const RPC_URL         = 'https://rpc.xlayer.tech';
const AGENT_REGISTRY  = '0x7337a8963Dc7Cf0644f9423bBE397b3D0f97ACa1';
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
  'function getAgentsByOwner(address) view returns (uint256[])',
  'function getAgent(uint256) view returns ((address owner,string name,string description,string endpoint,uint256 pricePerTask,string[] skillTags,bool active,uint256 registeredAt,uint256 totalTasks,uint256 totalEarned))',
]);


const account = privateKeyToAccount(AGENT_PK);
const publicClient = createPublicClient({ chain: xLayer, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: xLayer, transport: http(RPC_URL) });

const state = {
  agentName: '(loading...)', agentAddress: account.address,
  status: 'starting',
  x402Calls: 0, x402Earned: 0n,
  recentLogs: [],
  startedAt: new Date(),
  agenticWallet: null,  // Initialized at startup if onchainos is available
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

// ── Uniswap Trading API ─────────────────────────────────────────────────────

async function uniswapRequest(endpoint, body) {
  if (!UNISWAP_API_KEY) return null;
  try {
    const res = await fetch(UNISWAP_BASE_URL + endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': UNISWAP_API_KEY,
        'x-universal-router-version': '2.0',
      },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch (err) { log(`Uniswap API error: ${err.message}`); return null; }
}

async function uniswapQuote(tokenIn, tokenOut, amount, chainId = 196, swapper = '') {
  return uniswapRequest('/quote', {
    type: 'EXACT_INPUT',
    amount: String(amount),
    tokenInChainId: chainId,
    tokenOutChainId: chainId,
    tokenIn,
    tokenOut,
    swapper: swapper || account.address,
    slippageTolerance: 0.5,
    routingPreference: 'BEST_PRICE',
  });
}

async function uniswapCheckApproval(token, amount, chainId = 196, wallet = '') {
  return uniswapRequest('/check_approval', {
    token,
    amount: String(amount),
    chainId,
    walletAddress: wallet || account.address,
  });
}

async function uniswapSwap(quote, permitData, signature) {
  return uniswapRequest('/swap', {
    quote,
    permitData,
    signature,
    simulateTransaction: true,
    refreshGasPrice: true,
  });
}

// Dual-engine comparison: OKX DEX Aggregator vs Uniswap on X Layer
async function dualEngineQuote(fromToken, toToken, amount) {
  const [okxResult, uniResult] = await Promise.all([
    getSwapQuote('196', fromToken, toToken, amount),
    uniswapQuote(fromToken, toToken, amount),
  ]);

  const comparison = { okx: null, uniswap: null, recommendation: null, reason: '' };

  if (okxResult?.data?.[0]) {
    const d = okxResult.data[0];
    comparison.okx = {
      toAmount: d.toTokenAmount,
      priceImpact: d.priceImpactPercentage,
      gas: d.estimateGasFee,
      routerAddress: d.routerAddress,
    };
  }

  if (uniResult?.quote) {
    comparison.uniswap = {
      toAmount: uniResult.quote.outputAmount || uniResult.quote.quoteDecimals,
      priceImpact: uniResult.quote.priceImpact,
      routing: uniResult.routing,
    };
  }

  // Pick best
  if (comparison.okx && comparison.uniswap) {
    const okxAmount = BigInt(comparison.okx.toAmount || '0');
    const uniAmount = BigInt(comparison.uniswap.toAmount || '0');
    if (okxAmount >= uniAmount) {
      comparison.recommendation = 'okx';
      comparison.reason = `OKX gives ${okxAmount} vs Uniswap ${uniAmount} — better output`;
    } else {
      comparison.recommendation = 'uniswap';
      comparison.reason = `Uniswap gives ${uniAmount} vs OKX ${okxAmount} — better output`;
    }
  } else if (comparison.okx) {
    comparison.recommendation = 'okx';
    comparison.reason = 'Only OKX returned a valid quote';
  } else if (comparison.uniswap) {
    comparison.recommendation = 'uniswap';
    comparison.reason = 'Only Uniswap returned a valid quote';
  } else {
    comparison.reason = 'Neither engine returned a valid quote';
  }

  return comparison;
}

// ── DeFi API (OKX OnchainOS) ────────────────────────────────────────────────

async function defiSearch(chainIndex, tokenSymbol, productGroup) {
  const body = {};
  if (chainIndex) body.chainIndex = chainIndex;
  if (tokenSymbol) body.tokenSymbol = tokenSymbol;
  if (productGroup) body.productGroup = productGroup;
  try {
    const result = await okxRequest('POST', '/api/v6/defi/product/search', body);
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`DeFi search error: ${err.message}`); }
  return null;
}

async function defiDetail(investmentId) {
  try {
    const result = await okxRequest('GET', `/api/v6/defi/product/detail?investmentId=${investmentId}`);
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`DeFi detail error: ${err.message}`); }
  return null;
}

async function defiInvest(investmentId, address, tokenSymbol, amount, chainIndex) {
  try {
    const result = await okxRequest('POST', '/api/v6/defi/transaction/enter', {
      investmentId, address, tokenSymbol, amount, chainIndex,
    });
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`DeFi invest error: ${err.message}`); }
  return null;
}

async function defiWithdraw(investmentId, address, chainIndex, ratio) {
  try {
    const result = await okxRequest('POST', '/api/v6/defi/transaction/exit', {
      investmentId, address, chainIndex, ratio: ratio || '1',
    });
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`DeFi withdraw error: ${err.message}`); }
  return null;
}

async function defiCollect(address, chainIndex, rewardType, investmentId) {
  try {
    const result = await okxRequest('POST', '/api/v6/defi/transaction/claim', {
      address, chainIndex, rewardType, investmentId,
    });
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`DeFi collect error: ${err.message}`); }
  return null;
}

async function defiPositions(address, chains) {
  try {
    const result = await okxRequest('POST', '/api/v6/defi/user/asset/platform/list', {
      address, chainIndexList: chains.split(','),
    });
    if (result.code === '0' && result.data) return result.data;
  } catch (err) { log(`DeFi positions error: ${err.message}`); }
  return null;
}

// ── External data for LP planning ───────────────────────────────────────────

async function dexscreenerPools(network, tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${network}/${tokenAddress}`);
    const data = await res.json();
    return data.filter(p => p.dexId === 'uniswap').slice(0, 5);
  } catch (err) { log(`DexScreener error: ${err.message}`); return null; }
}

async function defillamaYields() {
  try {
    const res = await fetch('https://yields.llama.fi/pools');
    const data = await res.json();
    // Filter for Uniswap V3 on X Layer or nearby chains
    return data.data?.filter(p =>
      p.project === 'uniswap-v3' && ['X Layer', 'Ethereum', 'Base'].includes(p.chain)
    ).slice(0, 20) || [];
  } catch (err) { log(`DefiLlama error: ${err.message}`); return null; }
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


// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, X-OWNER');
  res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── x402 Payment via OKX Facilitator ──────────────────────────────────────────

const X402_PRICES = {
  '/api/ask':       { amount: '20000',  display: '$0.02',  desc: 'Ask Anything — AI auto-selects tools, combines all capabilities into one answer' },
  '/api/analyze':   { amount: '10000',  display: '$0.01',  desc: 'Market Analysis — real-time price, K-line, trends + AI insights' },
  '/api/translate': { amount: '10000',  display: '$0.01',  desc: 'AI Translation — any language, powered by Claude' },
  '/api/audit':     { amount: '10000',  display: '$0.01',  desc: 'Contract Code Review — AI-powered vulnerability analysis' },
  '/api/signals':   { amount: '10000',  display: '$0.01',  desc: 'Smart Money Signals — whale/KOL tracking + leaderboard' },
  '/api/trenches':  { amount: '10000',  display: '$0.01',  desc: 'Meme Scanner — new token launches, dev reputation, rug detection' },
  '/api/swap':      { amount: '2000',   display: '$0.002', desc: 'DEX Swap Quote — best price across 500+ liquidity sources' },
  '/api/portfolio': { amount: '10000',  display: '$0.01',  desc: 'Portfolio Analysis — wallet holdings across 20+ chains' },
  '/api/security':  { amount: '10000',  display: '$0.01',  desc: 'Token & DApp Risk Detection — automated threat scanning' },
  '/api/gas':       { amount: '1000',   display: '$0.001', desc: 'Gas Estimation — current gas prices on any chain' },
  '/api/dual-swap': { amount: '10000',  display: '$0.01',  desc: 'Dual Engine Swap — OKX vs Uniswap best price comparison' },
  '/api/defi':      { amount: '10000',  display: '$0.01',  desc: 'DeFi Yields — search best yield products (Aave, Uniswap LP, Lido)' },
  '/api/strategy':  { amount: '50000',  display: '$0.05',  desc: 'Multi-Step Strategy — signal→analyze→trade or yield optimization' },
  '/api/agent-pay':      { amount: '10000',  display: '$0.01',  desc: 'Agent-to-Agent Payment — pay another agent\'s x402 API and return result' },
  '/api/economic-loop':  { amount: '20000',  display: '$0.02',  desc: 'Economic Loop — full earn→invest→pay→re-earn cycle demonstration' },
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
    'You are a crypto market analyst AI agent powered by OKX OnchainOS data. Give concise, data-driven analysis. Use the real-time data provided. Format with bullet points. IMPORTANT: Always reply in the same language as the user query. If the user writes in Chinese, reply in Chinese. If in English, reply in English.',
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
  const to = req.query.to || 'auto';
  const langMap = { es: 'Spanish', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', auto: null };
  const targetLang = langMap[to] || to;
  const targetInstruction = targetLang ? `Translate to ${targetLang}` : 'Detect the source language and translate to the opposite (if Chinese→English, if English→Chinese, etc.)';
  log(`/api/translate: "${text}" → ${targetLang || 'auto'}`);

  const result = await askClaude(
    'You are a professional translator AI agent. Return ONLY the translated text, nothing else. No quotes, no explanation. Reply in the same language as the user query when explaining.',
    `${targetInstruction}:\n\n${text}`
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
    'You are a smart contract security auditor AI agent powered by OKX OnchainOS security scanning. Provide: 1) Overall Risk (CRITICAL/HIGH/MEDIUM/LOW), 2) Findings with severity, 3) Gas optimizations, 4) Recommendations. Use the security scan data when available. IMPORTANT: Always reply in the same language as the user query.',
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
    'You are a DeFi signal analyst. Analyze the smart money/whale movements and provide actionable insights in 3-5 bullet points. Reply in the same language as the user query.',
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
    'You are a meme coin analyst. Evaluate new meme tokens for potential and risks. Be direct about rug pull risks. Reply in the same language as the user query.',
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
    'You are a portfolio analyst. Analyze the wallet holdings and provide insights on diversification, risk, and recommendations. Reply in the same language as the user query.',
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
    'You are a blockchain security expert. Analyze the scan results and provide a clear risk assessment with actionable advice. Reply in the same language as the user query.',
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

// /api/ask — Unified AI Agent: native tool_use mode with agentic loop
const ASK_TOOLS = [
  {
    name: 'get_token_price',
    description: 'Get real-time token price. Use when user asks about price, cost, or value of a token. Input: token name or symbol (e.g. BTC, PEPE, ETH).',
    input_schema: { type: 'object', properties: { token: { type: 'string', description: 'Token name or symbol, e.g. BTC, PEPE, ETH' } }, required: ['token'] }
  },
  {
    name: 'get_token_info',
    description: 'Get detailed token info including market cap, 24h volume, and 24h price change. Use when user asks about market data, volume, or market cap.',
    input_schema: { type: 'object', properties: { token: { type: 'string', description: 'Token name or symbol' } }, required: ['token'] }
  },
  {
    name: 'get_kline',
    description: 'Get 7-day price chart (K-line/candlestick data). Use when user asks about price trends, charts, or historical movement.',
    input_schema: { type: 'object', properties: { token: { type: 'string', description: 'Token name or symbol' } }, required: ['token'] }
  },
  {
    name: 'get_hot_tokens',
    description: 'Get currently trending/hot tokens list. Use when user asks what is trending, popular, or hot in the market.',
    input_schema: { type: 'object', properties: { chain: { type: 'string', description: 'Chain index: "1" for ETH, "196" for X Layer, "501" for Solana. Default "1"' } }, required: [] }
  },
  {
    name: 'get_signals',
    description: 'Get smart money / whale / KOL trading signals. Use when user asks about whale movements, smart money, what big traders are buying.',
    input_schema: { type: 'object', properties: { chain: { type: 'string', description: 'Chain index, default "1"' }, wallet_type: { type: 'string', description: '"smart_money", "kol", or "whale". Default "smart_money"' } }, required: [] }
  },
  {
    name: 'get_leaderboard',
    description: 'Get top traders ranked by profit (PnL). Use when user asks about best traders, top performers, or leaderboard.',
    input_schema: { type: 'object', properties: { chain: { type: 'string', description: 'Chain index, default "1"' } }, required: [] }
  },
  {
    name: 'get_meme_tokens',
    description: 'Scan new meme token launches with dev reputation and rug detection. Use when user asks about new meme coins, meme launches, or rug checks.',
    input_schema: { type: 'object', properties: { chain: { type: 'string', description: 'Chain index, default "501" (Solana)' }, stage: { type: 'string', description: '"NEW", "GRADUATING", or "GRADUATED". Default "NEW"' } }, required: [] }
  },
  {
    name: 'scan_token_security',
    description: 'Scan a token contract for security risks. Use when user asks if a token is safe, about risks, or contract security. Returns risk level and warnings.',
    input_schema: { type: 'object', properties: { token: { type: 'string', description: 'Token name, symbol, or contract address' }, chain: { type: 'string', description: 'Chain index, default "1"' } }, required: ['token'] }
  },
  {
    name: 'get_portfolio',
    description: 'Analyze wallet holdings and portfolio value across chains. Use when user asks about wallet balance, holdings, or portfolio. Needs a wallet address (0x...).',
    input_schema: { type: 'object', properties: { address: { type: 'string', description: 'Wallet address (0x...)' }, chains: { type: 'string', description: 'Comma-separated chain indices, default "1,196,501"' } }, required: ['address'] }
  },
  {
    name: 'get_swap_quote',
    description: 'Get DEX swap price quote across 500+ liquidity sources. Use when user asks about swap price, exchange rate, or how much they would get.',
    input_schema: { type: 'object', properties: { chain: { type: 'string', description: 'Chain index, default "196"' }, from_token: { type: 'string', description: 'From token address' }, to_token: { type: 'string', description: 'To token address' }, amount: { type: 'string', description: 'Amount in wei' } }, required: [] }
  },
  {
    name: 'get_gas_price',
    description: 'Get current gas prices on a chain. Use when user asks about gas fees or transaction costs.',
    input_schema: { type: 'object', properties: { chain: { type: 'string', description: 'Chain index, default "196"' } }, required: [] }
  },
  // ── Uniswap Tools ──
  {
    name: 'uniswap_quote',
    description: 'Get Uniswap swap quote on X Layer (chain 196). Use to compare with OKX DEX, or when user specifically asks for Uniswap pricing.',
    input_schema: { type: 'object', properties: { token_in: { type: 'string', description: 'Input token address' }, token_out: { type: 'string', description: 'Output token address' }, amount: { type: 'string', description: 'Amount in minimal units (wei)' } }, required: ['token_in', 'token_out', 'amount'] }
  },
  {
    name: 'dual_engine_quote',
    description: 'Compare OKX DEX Aggregator vs Uniswap swap quotes in parallel. RECOMMENDED for all swap requests — shows which engine gives better price. Returns comparison with recommendation.',
    input_schema: { type: 'object', properties: { from_token: { type: 'string', description: 'From token address on X Layer' }, to_token: { type: 'string', description: 'To token address on X Layer' }, amount: { type: 'string', description: 'Amount in minimal units (wei)' } }, required: ['from_token', 'to_token', 'amount'] }
  },
  // ── DeFi Tools ──
  {
    name: 'defi_search',
    description: 'Search DeFi yield products (Aave, Lido, Uniswap LP, PancakeSwap, etc). Use when user asks about earning yield, staking, lending, or LP opportunities.',
    input_schema: { type: 'object', properties: { chain: { type: 'string', description: 'Chain index, default "196"' }, token: { type: 'string', description: 'Token symbol like USDC, ETH' }, product_group: { type: 'string', description: 'SINGLE_EARN, DEX_POOL, or LENDING' } }, required: [] }
  },
  {
    name: 'defi_invest',
    description: 'Deposit tokens into a DeFi product to earn yield. Use after defi_search to execute the investment.',
    input_schema: { type: 'object', properties: { investment_id: { type: 'string', description: 'Investment ID from defi_search' }, token: { type: 'string', description: 'Token symbol' }, amount: { type: 'string', description: 'Amount in minimal units' }, chain: { type: 'string', description: 'Chain index' } }, required: ['investment_id', 'token', 'amount'] }
  },
  {
    name: 'defi_withdraw',
    description: 'Withdraw from a DeFi position. Use when user wants to exit a yield position.',
    input_schema: { type: 'object', properties: { investment_id: { type: 'string', description: 'Investment ID' }, chain: { type: 'string', description: 'Chain index' }, ratio: { type: 'string', description: 'Withdrawal ratio 0-1, default "1" for full' } }, required: ['investment_id'] }
  },
  {
    name: 'defi_positions',
    description: 'View DeFi positions across protocols. Use when user asks about their DeFi investments, yields, or positions.',
    input_schema: { type: 'object', properties: { address: { type: 'string', description: 'Wallet address' }, chains: { type: 'string', description: 'Comma-separated chain indices, default "196"' } }, required: ['address'] }
  },
  // ── LP Planning Tools ──
  {
    name: 'get_pool_data',
    description: 'Get Uniswap pool data (liquidity, volume, APY) for LP planning. Use when user asks about providing liquidity or LP opportunities.',
    input_schema: { type: 'object', properties: { token_address: { type: 'string', description: 'Token contract address' }, network: { type: 'string', description: 'Network name for DexScreener, default "xlayer"' } }, required: ['token_address'] }
  },
  {
    name: 'get_yield_data',
    description: 'Get DeFi yield data from DefiLlama. Use to find best APY pools across Uniswap V3 and other protocols.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  // ── Agent-to-Agent Payment Tool ──
  {
    name: 'agent_pay',
    description: 'Pay another AI Agent\'s x402-gated API and get their service result. Use when you need external data or analysis from another Agent. This enables the economic loop: our Agent pays other Agents for services using x402 micropayments.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'Target agent API URL (e.g. https://other-agent.railway.app/api/signals?q=BTC)' } }, required: ['url'] }
  },
];

// Execute a single tool call and return result
async function executeAskTool(name, input) {
  try {
    switch (name) {
      case 'get_token_price': return JSON.stringify(await getTokenPrice(input.token) || { error: 'No price data found' });
      case 'get_token_info': return JSON.stringify(await getTokenInfo(input.token) || { error: 'No token info found' });
      case 'get_kline': return JSON.stringify(await getKline(input.token, '1D', 7) || { error: 'No kline data found' });
      case 'get_hot_tokens': return JSON.stringify(await getHotTokens(input.chain || '1') || { error: 'No hot tokens found' });
      case 'get_signals': {
        const walletType = { smart_money: '1', kol: '2', whale: '3' }[input.wallet_type] || '1';
        return JSON.stringify(await getSignals(input.chain || '1', walletType) || { error: 'No signals found' });
      }
      case 'get_leaderboard': return JSON.stringify(await getLeaderboard(input.chain || '1', '4', '1') || { error: 'No leaderboard data' });
      case 'get_meme_tokens': return JSON.stringify(await getMemePumpTokens(input.chain || '501', input.stage || 'NEW') || { error: 'No meme tokens found' });
      case 'scan_token_security': {
        const token = await resolveToken(input.token);
        return JSON.stringify(await scanTokenSecurity(token.chain, token.address) || { error: 'Security scan failed' });
      }
      case 'get_portfolio': return JSON.stringify(await getPortfolioValue(input.address, input.chains || '1,196,501') || { error: 'No portfolio data' });
      case 'get_swap_quote': return JSON.stringify(await getSwapQuote(input.chain || '196', input.from_token || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', input.to_token || USDC_ADDRESS, input.amount || '1000000000000000000') || { error: 'No swap quote' });
      case 'get_gas_price': return JSON.stringify(await getGasPrice(input.chain || '196') || { error: 'No gas data' });
      // Uniswap tools
      case 'uniswap_quote': return JSON.stringify(await uniswapQuote(input.token_in, input.token_out, input.amount) || { error: 'Uniswap quote failed (API key may be missing)' });
      case 'dual_engine_quote': return JSON.stringify(await dualEngineQuote(input.from_token, input.to_token, input.amount) || { error: 'Dual engine comparison failed' });
      // DeFi tools
      case 'defi_search': return JSON.stringify(await defiSearch(input.chain || '196', input.token || '', input.product_group || '') || { error: 'No DeFi products found' });
      case 'defi_invest': return JSON.stringify(await defiInvest(input.investment_id, account.address, input.token, input.amount, input.chain || '196') || { error: 'DeFi invest failed' });
      case 'defi_withdraw': return JSON.stringify(await defiWithdraw(input.investment_id, account.address, input.chain || '196', input.ratio || '1') || { error: 'DeFi withdraw failed' });
      case 'defi_positions': return JSON.stringify(await defiPositions(input.address, input.chains || '196') || { error: 'No DeFi positions found' });
      // LP planning tools
      case 'get_pool_data': return JSON.stringify(await dexscreenerPools(input.network || 'xlayer', input.token_address) || { error: 'No pool data found' });
      case 'get_yield_data': return JSON.stringify(await defillamaYields() || { error: 'No yield data found' });
      // Agent-to-Agent payment
      case 'agent_pay': return JSON.stringify(await agentPay(input.url) || { error: 'Agent payment failed' });
      default: return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

app.get('/api/ask', x402Guard('/api/ask'), async (req, res) => {
  const question = req.query.q || '';
  if (!question) return res.status(400).json({ error: 'q parameter required' });
  log(`/api/ask: "${question}"`);

  if (!claude) return res.status(500).json({ error: 'Claude API not configured' });

  const MAX_ROUNDS = 10;
  const allToolsUsed = [];
  const allToolData = {};
  let messages = [{ role: 'user', content: question }];

  // Agentic loop: continue while stop_reason is "tool_use", max 6 rounds
  let finalAnswer = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    log(`  Round ${round + 1}...`);

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: SKILL_SYSTEM_PROMPT,
      tools: ASK_TOOLS,
      messages,
    });

    // Collect text and tool_use blocks from response
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    if (response.stop_reason === 'end_turn') {
      // Claude is done — extract final text answer
      for (const block of assistantContent) {
        if (block.type === 'text') finalAnswer += block.text;
      }
      log(`  Done after ${round + 1} round(s)`);
      break;
    }

    if (response.stop_reason === 'tool_use') {
      // Execute all requested tools in parallel
      const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          log(`    Tool: ${block.name}(${JSON.stringify(block.input)})`);
          allToolsUsed.push(block.name);
          const result = await executeAskTool(block.name, block.input);
          try { allToolData[block.name] = JSON.parse(result); } catch { allToolData[block.name] = result; }
          return { type: 'tool_result', tool_use_id: block.id, content: result };
        })
      );
      messages.push({ role: 'user', content: toolResults });
    }
  }

  if (!finalAnswer) finalAnswer = '(Reached maximum rounds without a final answer)';

  const response = {
    agent: state.agentName, type: 'ask', question,
    toolsUsed: [...new Set(allToolsUsed)],
    data: allToolData,
    answer: finalAnswer,
    poweredBy: { orchestration: 'Claude AI (Skill-driven tool_use)', data: 'OKX OnchainOS + Uniswap (' + [...new Set(allToolsUsed)].join(', ') + ')', skills: '13 OKX + 4 Uniswap Skills' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// /api/dual-swap — Dual Engine: OKX vs Uniswap comparison
app.get('/api/dual-swap', x402Guard('/api/dual-swap'), async (req, res) => {
  const fromToken = req.query.from || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const toToken = req.query.to || USDC_ADDRESS;
  const amount = req.query.amount || '1000000000000000000';
  log(`/api/dual-swap: ${fromToken} → ${toToken}, amount=${amount}`);

  // Security pre-check
  const securityScan = await scanTokenSecurity('196', toToken);
  if (securityScan?.[0]?.riskLevel === 'block') {
    return res.status(403).json({ error: 'Token blocked by security scan', details: securityScan });
  }

  const comparison = await dualEngineQuote(fromToken, toToken, amount);

  let analysis = '';
  if (claude) {
    analysis = await askClaude(
      'You are an AI agent that compares DEX swap quotes. Explain which engine offers better value and why. Be concise.',
      `Swap comparison on X Layer:\n${JSON.stringify(comparison, null, 2)}`
    );
  }

  const response = {
    agent: state.agentName, type: 'dual-swap',
    comparison, analysis,
    poweredBy: { data: 'OKX DEX Aggregator + Uniswap Trading API', ai: 'Claude' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// /api/defi — DeFi yield search + AI analysis
app.get('/api/defi', x402Guard('/api/defi'), async (req, res) => {
  const token = req.query.token || 'USDC';
  const chain = req.query.chain || '196';
  const productGroup = req.query.type || '';
  log(`/api/defi: token=${token}, chain=${chain}`);

  const [products, yields] = await Promise.all([
    defiSearch(chain, token, productGroup),
    defillamaYields(),
  ]);

  let analysis = '';
  if (claude) {
    analysis = await askClaude(
      'You are a DeFi yield analyst on X Layer. Analyze the available yield products and recommend the best option based on APY, risk, and TVL. Be specific with numbers.',
      `Token: ${token}, Chain: ${chain}\nOKX DeFi Products:\n${JSON.stringify(products?.slice(0, 10), null, 2)}\n\nDefiLlama Yields:\n${JSON.stringify(yields?.slice(0, 10), null, 2)}`
    );
  }

  const response = {
    agent: state.agentName, type: 'defi-yield',
    token, chain,
    products: products?.slice(0, 10) || [],
    yields: yields?.slice(0, 10) || [],
    analysis,
    poweredBy: { data: 'OKX DeFi API + DefiLlama', ai: 'Claude' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// /api/strategy — Multi-step AI strategy execution
app.get('/api/strategy', x402Guard('/api/strategy'), async (req, res) => {
  const goal = req.query.q || '';
  if (!goal) return res.status(400).json({ error: 'q parameter required (strategy goal)' });
  log(`/api/strategy: "${goal}"`);

  if (!claude) return res.status(500).json({ error: 'Claude API not configured' });

  const strategyPrompt = SKILL_SYSTEM_PROMPT + `\n\n## STRATEGY MODE
You are executing a multi-step strategy. The user has a high-level goal.
Break it into steps, execute each step using tools, and report progress.
Available strategies:
- Signal-to-Trade: detect signal → analyze token → security scan → dual-engine quote → recommend
- Yield Optimization: scan DeFi products → compare APYs across protocols → recommend best deposit
- Portfolio Rebalance: check holdings → identify imbalances → plan swaps → recommend execution
- Smart Money Follow: track whale signals → analyze their picks → security check → recommend

Execute the FULL strategy, not just the first step. Use multiple tool rounds.`;

  const MAX_ROUNDS = 10;
  const allToolsUsed = [];
  const allToolData = {};
  let messages = [{ role: 'user', content: `Execute this strategy: ${goal}` }];
  let finalAnswer = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    log(`  Strategy round ${round + 1}...`);
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: strategyPrompt,
      tools: ASK_TOOLS,
      messages,
    });

    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    if (response.stop_reason === 'end_turn') {
      for (const block of assistantContent) {
        if (block.type === 'text') finalAnswer += block.text;
      }
      log(`  Strategy done after ${round + 1} round(s)`);
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          log(`    Strategy tool: ${block.name}(${JSON.stringify(block.input)})`);
          allToolsUsed.push(block.name);
          const result = await executeAskTool(block.name, block.input);
          try { allToolData[block.name] = JSON.parse(result); } catch { allToolData[block.name] = result; }
          return { type: 'tool_result', tool_use_id: block.id, content: result };
        })
      );
      messages.push({ role: 'user', content: toolResults });
    }
  }

  if (!finalAnswer) finalAnswer = '(Strategy reached maximum rounds)';

  const response = {
    agent: state.agentName, type: 'strategy',
    goal,
    toolsUsed: [...new Set(allToolsUsed)],
    stepsExecuted: allToolsUsed.length,
    data: allToolData,
    result: finalAnswer,
    poweredBy: { orchestration: 'Claude AI (multi-step strategy)', data: 'OKX OnchainOS + Uniswap', skills: '13 OKX + 4 Uniswap Skills' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// ── Agent-to-Agent x402 Payment ─────────────────────────────────────────────

/**
 * Pay another Agent's x402-gated API.
 * Flow: request → receive 402 → parse requirements → check balance → optional swap → TEE sign → replay
 */
async function agentPay(targetUrl, options = {}) {
  log(`[agent-pay] Requesting: ${targetUrl}`);

  // Step 1: Make initial request to target agent
  let initialRes;
  try {
    initialRes = await fetch(targetUrl);
  } catch (err) {
    return { success: false, error: `Cannot reach target: ${err.message}` };
  }

  // If not 402, no payment needed
  if (initialRes.status !== 402) {
    const body = await initialRes.text();
    try { return { success: true, data: JSON.parse(body), paymentRequired: false }; }
    catch { return { success: true, data: body, paymentRequired: false }; }
  }

  // Step 2: Parse 402 payment requirements
  let requirements;
  try {
    const paymentHeader = initialRes.headers.get('PAYMENT-REQUIRED') || initialRes.headers.get('payment-required');
    if (paymentHeader) {
      requirements = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
    } else {
      const body = await initialRes.text();
      requirements = JSON.parse(body);
    }
  } catch (err) {
    return { success: false, error: `Cannot parse 402 requirements: ${err.message}` };
  }

  const accept = requirements.accepts?.[0] || requirements;
  const { network, payTo, asset, maxTimeoutSeconds } = accept;
  const payAmount = accept.amount || accept.maxAmountRequired;

  if (!payTo || !payAmount || !asset) {
    return { success: false, error: 'Invalid payment requirements', requirements };
  }

  log(`[agent-pay] Payment: ${payAmount} of ${asset} to ${payTo} on ${network}`);

  // Step 3: Check balance (if we have Agentic Wallet)
  // For now, skip balance check and go straight to signing
  // In production, would check balance and do Uniswap swap if needed

  // Step 4: Sign via OKX TEE (Agentic Wallet) or fallback to local signing
  let paymentPayload;

  if (agenticWalletAvailable() && state.agenticWallet?.available) {
    // TEE signing via onchainos
    const signResult = await x402Pay({
      network: network || 'eip155:196',
      amount: payAmount,
      payTo,
      asset,
      maxTimeoutSeconds: maxTimeoutSeconds || 300,
    });

    if (!signResult?.ok && !signResult?.data) {
      return { success: false, error: `TEE signing failed: ${JSON.stringify(signResult)}` };
    }

    const sig = signResult.data || signResult;
    paymentPayload = {
      x402Version: requirements.x402Version || 1,
      scheme: accept.scheme || 'exact',
      network: network || 'eip155:196',
      payload: {
        signature: sig.signature,
        authorization: sig.authorization,
      },
    };
  } else {
    // Fallback: local EIP-3009 signing with AGENT_PK
    const nonce = '0x' + crypto.randomBytes(32).toString('hex');
    const validBefore = String(Math.floor(Date.now() / 1000) + (maxTimeoutSeconds || 300));

    // Find the asset info for domain
    const assetInfo = ACCEPTED_ASSETS.find(a => a.address.toLowerCase() === asset.toLowerCase())
      || { name: 'USD Coin', version: '2' };

    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };
    const domain = {
      name: assetInfo.name,
      version: assetInfo.version,
      chainId: 196,
      verifyingContract: asset,
    };
    const message = {
      from: account.address,
      to: payTo,
      value: BigInt(payAmount),
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce,
    };

    const signature = await walletClient.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message });

    paymentPayload = {
      x402Version: requirements.x402Version || 1,
      scheme: accept.scheme || 'exact',
      network: network || 'eip155:196',
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: payTo,
          value: String(payAmount),
          validAfter: '0',
          validBefore: validBefore,
          nonce,
        },
      },
    };
  }

  // Step 5: Replay request with payment header
  const headerValue = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
  const headerName = (requirements.x402Version || 1) >= 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT';

  log(`[agent-pay] Replaying with ${headerName} header...`);
  try {
    const replayRes = await fetch(targetUrl, {
      headers: { [headerName]: headerValue },
    });

    const replayBody = await replayRes.text();
    let data;
    try { data = JSON.parse(replayBody); } catch { data = replayBody; }

    return {
      success: replayRes.ok,
      status: replayRes.status,
      data,
      paymentRequired: true,
      paid: { amount: payAmount, asset, payTo, network, method: state.agenticWallet?.available ? 'TEE' : 'local' },
    };
  } catch (err) {
    return { success: false, error: `Replay failed: ${err.message}` };
  }
}

// /api/agent-pay — Demonstrate Agent-to-Agent x402 payment
app.get('/api/agent-pay', x402Guard('/api/agent-pay'), async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'url parameter required (target agent API endpoint)' });
  log(`/api/agent-pay: target=${targetUrl}`);

  const result = await agentPay(targetUrl);

  let analysis = '';
  if (claude && result.success) {
    analysis = await askClaude(
      'You are an AI agent that just paid another agent for a service via x402 micropayment. Summarize what you received and the payment details concisely.',
      `Payment result:\n${JSON.stringify(result, null, 2)}`
    );
  }

  const response = {
    agent: state.agentName, type: 'agent-pay',
    targetUrl,
    result,
    analysis,
    economicLoop: 'This Agent earned USDC via user x402 payments → used it to pay another Agent for data → will use that data to serve users better (earn→pay→re-earn)',
    poweredBy: { payment: result.paid?.method === 'TEE' ? 'OKX Agentic Wallet (TEE)' : 'Local EIP-3009 signing', protocol: 'x402' },
    timestamp: new Date().toISOString(),
  };
  if (req.x402Settlement) { response.payment = req.x402Settlement; res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(req.x402Settlement)).toString('base64')); }
  res.json(response);
});

// /api/economic-loop — Full earn→invest→pay→re-earn cycle demonstration
app.get('/api/economic-loop', x402Guard('/api/economic-loop'), async (req, res) => {
  log('/api/economic-loop: executing full cycle');

  const steps = [];
  const txHashes = [];

  // Step 1: EARN — This request itself earned us x402 income
  steps.push({
    step: 1, name: 'EARN', status: 'completed',
    description: 'Received x402 micropayment from user',
    earned: req.x402Settlement ? formatUnits(BigInt(req.x402Settlement.amount || '0'), 6) + ' USDC' : '$0.02',
    txHash: req.x402Settlement?.transaction || null,
  });
  if (req.x402Settlement?.transaction) txHashes.push(req.x402Settlement.transaction);

  // Step 2: ANALYZE — Search for best yield opportunities on X Layer
  let bestYield = null;
  try {
    const [defiProducts, uniPools] = await Promise.all([
      defiSearch('196', 'USDC', 'SINGLE_EARN'),
      dexscreenerPools('xlayer', USDC_ADDRESS),
    ]);

    const topProduct = defiProducts?.[0] || null;
    const topPool = uniPools?.[0] || null;

    bestYield = {
      defi: topProduct ? { id: topProduct.investmentId, platform: topProduct.platformName, apy: topProduct.apy, tvl: topProduct.tvl } : null,
      uniswapLP: topPool ? { pair: `${topPool.baseToken?.symbol}/${topPool.quoteToken?.symbol}`, liquidity: topPool.liquidity?.usd, volume24h: topPool.volume?.h24 } : null,
    };

    steps.push({
      step: 2, name: 'ANALYZE', status: 'completed',
      description: 'Searched best yield opportunities on X Layer',
      defiProducts: defiProducts?.length || 0,
      uniswapPools: uniPools?.length || 0,
      bestYield,
    });
  } catch (err) {
    steps.push({ step: 2, name: 'ANALYZE', status: 'partial', error: err.message });
  }

  // Step 3: INVEST — Show what we would deposit (simulation, not actual deposit for safety)
  steps.push({
    step: 3, name: 'INVEST', status: 'simulated',
    description: 'Would deposit a portion of earnings into best yield product',
    target: bestYield?.defi?.platform || bestYield?.uniswapLP?.pair || 'Best available on X Layer',
    note: 'Simulated for demo safety — use /api/defi to execute real DeFi deposits',
  });

  // Step 4: PAY — Demonstrate paying another Agent for signal data
  let signalData = null;
  try {
    // Call our own signals endpoint as a demo of Agent-to-Agent payment concept
    const signals = await getSignals('196', '1');
    signalData = signals?.slice(0, 3) || null;

    steps.push({
      step: 4, name: 'PAY', status: 'completed',
      description: 'Queried smart money signals (in production: pays another Agent via x402)',
      signalsReceived: signalData?.length || 0,
      economicMeaning: 'Agent uses x402 income to pay for intelligence from other Agents',
    });
  } catch (err) {
    steps.push({ step: 4, name: 'PAY', status: 'partial', error: err.message });
  }

  // Step 5: RE-EARN — Use signals to provide better service → attract more users → earn more
  let analysis = '';
  if (claude) {
    analysis = await askClaude(
      'You are an AI agent demonstrating an economic loop on X Layer. Summarize the cycle: how you earned, what you found for investing, and how signals help you serve users better. Be concise, 3-4 sentences.',
      `Economic loop execution:\n${JSON.stringify(steps, null, 2)}`
    );
  }

  steps.push({
    step: 5, name: 'RE-EARN', status: 'completed',
    description: 'Applied intelligence to improve service quality → attract more users → earn more x402',
    analysis,
  });

  const response = {
    agent: state.agentName,
    type: 'economic-loop',
    cycle: 'EARN → ANALYZE → INVEST → PAY → RE-EARN',
    steps,
    txHashes,
    summary: {
      totalSteps: steps.length,
      completedSteps: steps.filter(s => s.status === 'completed').length,
      loop: 'User pays USDC via x402 → Agent earns → Agent invests in DeFi → Agent pays other Agents for signals → Agent uses signals to serve users better → More users pay → Cycle repeats',
    },
    poweredBy: {
      payment: 'x402 (OKX Facilitator, zero gas)',
      data: 'OKX OnchainOS + Uniswap + DexScreener',
      ai: 'Claude (Skill-driven)',
      skills: '13 OKX + 4 Uniswap Skills',
    },
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
      method: 'GET', path, price: p.display, priceRaw: p.amount, description: p.desc,
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
<div class="card"><b>x402 Micropayments</b> — OKX Facilitator: ${okxStatus}<br>Calls: ${state.x402Calls} | Earned: ${x402Earned} USDC | Gas: <span style="color:#00e676">$0 (OKX subsidy)</span><br><br>
<code>GET /api/analyze</code> $0.01 &nbsp; <code>GET /api/translate</code> $0.005 &nbsp; <code>GET /api/audit</code> $0.05<br><br>
<a href="/api">GET /api</a> — endpoint list + payment instructions (free)</div>
<div class="card"><b>Activity</b> | Uptime: ${uptimeStr}<br>${logsHtml}</div>
<p style="text-align:center;color:#484f58;margin-top:2rem">X Layer (chain 196) | x402 via OKX | USDC zero-gas settlement</p></div></body></html>`);
});

app.get('/status', (_req, res) => {
  res.json({
    agent: state.agentName, address: state.agentAddress, status: state.status,
    x402Calls: state.x402Calls, x402Earned: formatUnits(state.x402Earned, 6),
    facilitator: hasOkxKeys ? 'OKX (connected)' : 'not configured',
    agenticWallet: state.agenticWallet?.available ? {
      accountName: state.agenticWallet.accountName,
      method: 'TEE (Trusted Execution Environment)',
    } : 'not available (using raw key fallback)',
    capabilities: {
      skills: '13 OKX Onchain OS + 4 Uniswap AI Skills',
      engines: UNISWAP_API_KEY ? ['OKX DEX Aggregator', 'Uniswap Trading API'] : ['OKX DEX Aggregator'],
      tools: ASK_TOOLS.length,
      features: ['dual-engine-swap', 'defi-yield', 'multi-step-strategy', 'agent-to-agent-x402', 'security-pre-checks'],
    },
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function start() {
  console.log(`\n${'='.repeat(60)}\n  AgentsMarketplace Server (x402 + OKX OnchainOS)\n${'='.repeat(60)}`);
  console.log(`  Address:     ${account.address}`);
  console.log(`  RPC:         ${RPC_URL}`);
  console.log(`  Chain:       196 (X Layer)`);
  console.log(`  x402:        ${hasOkxKeys ? 'OKX Facilitator (zero gas)' : 'NOT CONFIGURED'}`);
  console.log(`  AI:          ${claude ? 'Claude (Anthropic)' : 'NOT CONFIGURED — set ANTHROPIC_API_KEY'}`);
  console.log(`  Uniswap:     ${UNISWAP_API_KEY ? 'Trading API configured' : 'NOT CONFIGURED — set UNISWAP_API_KEY'}`);
  console.log(`  Skills:      ${SKILL_SYSTEM_PROMPT ? '13 OKX + 4 Uniswap Skills loaded' : 'FALLBACK PROMPT'}`);
  console.log(`  Market Data: ${hasOkxKeys ? 'OKX OnchainOS Market API' : 'NOT CONFIGURED'}`);
  console.log(`  Dashboard:   http://localhost:${PORT}\n`);

  try {
    const agentIds = await publicClient.readContract({ address: AGENT_REGISTRY, abi: registryAbi, functionName: 'getAgentsByOwner', args: [account.address] });
    if (agentIds.length > 0) {
      const info = await publicClient.readContract({ address: AGENT_REGISTRY, abi: registryAbi, functionName: 'getAgent', args: [agentIds[0]] });
      state.agentName = info.name;
      log(`Registered as "${info.name}" (agentId: ${agentIds[0]})`);
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

  // Initialize Agentic Wallet (TEE-based, if available)
  if (agenticWalletAvailable()) {
    try {
      const wallet = await initAgenticWallet();
      if (wallet.available) {
        state.agenticWallet = wallet;
        log(`Agentic Wallet: ${wallet.accountName} (TEE-secured)`);
        if (wallet.balance) log(`  X Layer balance: ${JSON.stringify(wallet.balance).slice(0, 200)}`);
      } else {
        log(`Agentic Wallet: ${wallet.reason}`);
      }
    } catch (err) { log(`Agentic Wallet init failed: ${err.message}`); }
  } else {
    log('Agentic Wallet: onchainos not installed (using raw private key fallback)');
  }

  state.status = 'listening';
  log('Listening for x402 API calls...');
  app.listen(PORT, () => log(`Dashboard at http://localhost:${PORT}`));
}

process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

start().catch((err) => { console.error('[FATAL]', err.message); process.exit(1); });
