#!/usr/bin/env node
/**
 * demo-full-flow.mjs — End-to-end AgentsMarketplace Marketplace demo
 *
 * Usage:
 *   AGENT_PRIVATE_KEY=0x... CLIENT_PRIVATE_KEY=0x... node scripts/demo-full-flow.mjs
 */

import { createPublicClient, createWalletClient, http, defineChain, parseAbi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC_URL = 'https://rpc.xlayer.tech';

const AGENT_PK = process.env.AGENT_PRIVATE_KEY;
const CLIENT_PK = process.env.CLIENT_PRIVATE_KEY;
if (!AGENT_PK || !CLIENT_PK) {
  console.error('Set AGENT_PRIVATE_KEY and CLIENT_PRIVATE_KEY environment variables.');
  process.exit(1);
}

const AGENT_REGISTRY    = '0xBeA9d2d1766C2E9498334D45C479046c28F49Ae2';
const TASK_MANAGER      = '0x77B5A2Ab2dc74A5f9892e7e18c96B05cbd822D08';
const REPUTATION_ENGINE = '0x826ca4b36A17a73a22FA0bbE0A1D95432771B2f6';
const NANOPAY_DEMO      = '0x2e6C48b3240ab6fED223B73b3903976C1D899B42';
const USDC_ADDRESS      = '0x74b7F16337b8972027F6196A17a631aC6dE26d22';

const TASK_PAYMENT = 500_000n; // 0.5 USDC

const xLayer = defineChain({
  id: 196, name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const registryAbi = parseAbi([
  'function registerAgent(string,string,string,uint256,string[])',
  'function isRegistered(address) view returns (bool)',
  'function getAgent(address) view returns ((string name,string description,string endpoint,uint256 pricePerTask,string[] skillTags,bool active,uint256 registeredAt,uint256 totalTasks,uint256 totalEarned))',
]);

const taskManagerAbi = parseAbi([
  'function createTask(address agent,string description,uint256 payment) returns (uint256 taskId)',
  'function acceptTask(uint256 taskId)',
  'function completeTask(uint256 taskId,string resultHash)',
  'function approveTask(uint256 taskId)',
  'function rateAgent(uint256 taskId,uint8 rating,string comment)',
  'function getTask(uint256 taskId) view returns ((address client,address agent,string description,uint256 payment,string resultHash,uint8 state,uint256 createdAt,uint256 acceptedAt,uint256 completedAt,uint256 disputedAt))',
  'function getTaskCount() view returns (uint256)',
]);

const reputationAbi = parseAbi([
  'function getReputation(address agent) view returns ((uint256 totalRatings,uint256 totalScore,uint256 totalTasks))',
]);

const nanopayAbi = parseAbi([
  'function recordPayment(address agent,uint256 amount,string taskType)',
  'function getPaymentCount() view returns (uint256)',
]);

const erc20Abi = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
]);

const TASK_STATES = ['Created', 'InProgress', 'Completed', 'Approved', 'Disputed', 'Resolved', 'Cancelled'];

function separator(title) { console.log(`\n${'='.repeat(60)}\n  STEP: ${title}\n${'='.repeat(60)}`); }

async function sendTx(walletClient, publicClient, params, label) {
  console.log(`  [>] Sending: ${label}...`);
  const hash = await walletClient.writeContract(params);
  console.log(`      Tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`      [+] Confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function main() {
  console.log('\n' + '#'.repeat(60));
  console.log('#   AgentsMarketplace Marketplace — Full Demo Flow');
  console.log('#'.repeat(60));

  const agentAccount = privateKeyToAccount(AGENT_PK);
  const clientAccount = privateKeyToAccount(CLIENT_PK);
  console.log(`\n[*] Agent wallet:  ${agentAccount.address}`);
  console.log(`[*] Client wallet: ${clientAccount.address}`);

  const pub = createPublicClient({ chain: xLayer, transport: http() });
  const agentWal = createWalletClient({ account: agentAccount, chain: xLayer, transport: http() });
  const clientWal = createWalletClient({ account: clientAccount, chain: xLayer, transport: http() });

  // 0. Pre-flight
  separator('Pre-flight checks');
  const agentBal = await pub.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [agentAccount.address] });
  const clientBal = await pub.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [clientAccount.address] });
  console.log(`  Agent USDC:  ${formatUnits(agentBal, 6)}`);
  console.log(`  Client USDC: ${formatUnits(clientBal, 6)}`);

  // 1. Register
  separator('1 — Register Agent');
  const isReg = await pub.readContract({ address: AGENT_REGISTRY, abi: registryAbi, functionName: 'isRegistered', args: [agentAccount.address] });
  if (isReg) {
    console.log('  [i] Already registered — skipping.');
  } else {
    await sendTx(agentWal, pub, {
      address: AGENT_REGISTRY, abi: registryAbi, functionName: 'registerAgent',
      args: ['CodeReviewer-AI', 'Autonomous smart contract security auditor', 'https://agentsmarketplace.app/api/code-review', 500_000n, ['solidity', 'audit', 'security', 'ai-agent']],
    }, 'registerAgent("CodeReviewer-AI")');
  }

  // 2. Create task
  separator('2 — Client Creates Task');
  const allowance = await pub.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance', args: [clientAccount.address, TASK_MANAGER] });
  if (allowance < TASK_PAYMENT) {
    await sendTx(clientWal, pub, {
      address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve',
      args: [TASK_MANAGER, TASK_PAYMENT * 10n],
    }, `approve(TaskManager, ${formatUnits(TASK_PAYMENT * 10n, 6)} USDC)`);
  }
  const taskCountBefore = await pub.readContract({ address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'getTaskCount' });
  await sendTx(clientWal, pub, {
    address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'createTask',
    args: [agentAccount.address, 'Audit the AgentsMarketplace contracts for reentrancy, access control, and economic attack vectors', TASK_PAYMENT],
  }, 'createTask(0.5 USDC)');
  const taskId = taskCountBefore;

  // 3-7: Accept, Complete, Approve, Rate, Nanopay
  separator('3 — Agent Accepts Task');
  await sendTx(agentWal, pub, { address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'acceptTask', args: [taskId] }, `acceptTask(${taskId})`);

  separator('4 — Agent Completes Task');
  await sendTx(agentWal, pub, { address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'completeTask', args: [taskId, 'QmAuditReport_no_critical_issues'] }, `completeTask(${taskId})`);

  separator('5 — Client Approves');
  await sendTx(clientWal, pub, { address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'approveTask', args: [taskId] }, `approveTask(${taskId})`);

  separator('6 — Client Rates Agent');
  await sendTx(clientWal, pub, { address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'rateAgent', args: [taskId, 5, 'Thorough audit. Fast turnaround.'] }, 'rateAgent(5 stars)');

  separator('7 — Record Nanopayment');
  await sendTx(clientWal, pub, { address: NANOPAY_DEMO, abi: nanopayAbi, functionName: 'recordPayment', args: [agentAccount.address, TASK_PAYMENT, 'security-audit'] }, 'recordPayment');

  console.log('\n' + '#'.repeat(60));
  console.log('#   Demo Complete!');
  console.log('#'.repeat(60));
}

main().catch((err) => { console.error('\n[x] Fatal:', err.shortMessage || err.message); process.exit(1); });
