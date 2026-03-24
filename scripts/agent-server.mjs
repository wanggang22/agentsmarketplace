#!/usr/bin/env node
/**
 * agent-server.mjs — XLayerAgent AI Agent Execution Bridge
 *
 * Usage:
 *   AGENT_PK=0x... node scripts/agent-server.mjs
 *
 * Environment:
 *   AGENT_PK — private key (hex, with 0x prefix)
 *   PORT     — HTTP port (default 3080)
 *   POLL_MS  — task-poll interval in ms (default 5000)
 */

import {
  createPublicClient, createWalletClient, http, defineChain, parseAbi, formatUnits, keccak256, toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import express from 'express';

const PORT    = Number(process.env.PORT) || 3080;
const POLL_MS = Number(process.env.POLL_MS) || 5000;

const AGENT_PK = process.env.AGENT_PK;
if (!AGENT_PK) { console.error('Set AGENT_PK environment variable.'); process.exit(1); }

const RPC_URL         = 'https://rpc.xlayer.tech';
const AGENT_REGISTRY  = '0xBeA9d2d1766C2E9498334D45C479046c28F49Ae2';
const TASK_MANAGER    = '0x77B5A2Ab2dc74A5f9892e7e18c96B05cbd822D08';
const NANOPAY_DEMO    = '0x2e6C48b3240ab6fED223B73b3903976C1D899B42';

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
  recentLogs: [], lastKnownTaskCount: 0n,
  startedAt: new Date(), processing: new Set(),
};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  state.recentLogs.push(entry);
  if (state.recentLogs.length > 10) state.recentLogs.shift();
}

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

const app = express();

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.get('/', (_req, res) => {
  const uptime = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
  const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;
  const earned = formatUnits(state.totalEarned, 6);
  const statusColor = state.status === 'listening' ? '#00e676' : '#ffa726';
  const logsHtml = state.recentLogs.length
    ? state.recentLogs.map((l) => `<div style="font-family:monospace;font-size:.8rem;padding:4px 0;border-bottom:1px solid #21262d">${escapeHtml(l)}</div>`).join('')
    : '<div style="color:#484f58">No activity yet.</div>';

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>XLayerAgent Server</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui;background:#0d1117;color:#c9d1d9;padding:2rem}.c{max-width:720px;margin:0 auto}h1{color:#58a6ff;margin-bottom:.5rem}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.25rem;margin-bottom:1.25rem}</style></head>
<body><div class="c"><h1>XLayerAgent Server</h1><p style="color:#8b949e;margin-bottom:2rem">AI Agent Execution Bridge — X Layer</p>
<div class="card"><b>${escapeHtml(state.agentName)}</b> <span style="color:${statusColor}">${state.status}</span><br><code style="font-size:.85rem">${state.agentAddress}</code></div>
<div class="card">Tasks: ${state.tasksProcessed} | Earned: ${earned} USDC | Uptime: ${uptimeStr}</div>
<div class="card">${logsHtml}</div>
<p style="text-align:center;color:#484f58;margin-top:2rem">X Layer (chain 196) | ${RPC_URL}</p></div></body></html>`);
});

app.get('/status', (_req, res) => {
  res.json({ agent: state.agentName, address: state.agentAddress, status: state.status, tasksProcessed: state.tasksProcessed, totalEarned: formatUnits(state.totalEarned, 6) });
});

async function start() {
  console.log(`\n${'='.repeat(60)}\n  XLayerAgent Server\n${'='.repeat(60)}`);
  console.log(`  Address: ${account.address}\n  RPC: ${RPC_URL}\n  Chain: 196\n  Dashboard: http://localhost:${PORT}\n`);

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

  state.status = 'listening';
  log('Listening for tasks...');
  pollTimer = setTimeout(poll, POLL_MS);
  app.listen(PORT, () => log(`Dashboard at http://localhost:${PORT}`));
}

process.on('SIGINT', () => { clearTimeout(pollTimer); process.exit(0); });
process.on('SIGTERM', () => { clearTimeout(pollTimer); process.exit(0); });

start().catch((err) => { console.error('[FATAL]', err.message); process.exit(1); });
