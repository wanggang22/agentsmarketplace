#!/usr/bin/env node
/**
 * check-status.mjs — Query and display AgentsMarketplace Marketplace state
 *
 * Usage:  node scripts/check-status.mjs
 */

import { createPublicClient, http, defineChain, parseAbi, formatUnits } from 'viem';

const RPC_URL = 'https://rpc.xlayer.tech';

const AGENT_REGISTRY    = '0x7337a8963Dc7Cf0644f9423bBE397b3D0f97ACa1';
const TASK_MANAGER      = '0x599e23D6073426eBe357d03056258eEAa217e01D';
const REPUTATION_ENGINE = '0x3bf87bf49141B014e4Eef71A661988624c1af29F';
const NANOPAY_DEMO      = '0x850747924481c0B1Ad3Eca2f60810Ff91B72b6ef';

const xLayer = defineChain({
  id: 196, name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const registryAbi = parseAbi([
  'function getAgentCount() view returns (uint256)',
  'function getAgentsPaginated(uint256 _offset, uint256 _limit) view returns ((string name,string description,string endpoint,uint256 pricePerTask,string[] skillTags,bool active,uint256 registeredAt,uint256 totalTasks,uint256 totalEarned)[] agents, address[] addresses)',
]);

const taskManagerAbi = parseAbi([
  'function getTaskCount() view returns (uint256)',
  'function getTask(uint256 taskId) view returns ((address client,address agent,string description,uint256 payment,string resultHash,uint8 state,uint256 createdAt,uint256 acceptedAt,uint256 completedAt))',
]);

const reputationAbi = parseAbi([
  'function getReputation(address agent) view returns (uint256 totalTasks,uint256 avgRatingX100,uint256 totalRatings)',
  'function getReviewCount(address agent) view returns (uint256)',
  'function getReviews(address agent,uint256 offset,uint256 limit) view returns ((uint256 taskId,address reviewer,uint8 rating,string comment,uint256 timestamp)[])',
]);

const nanopayAbi = parseAbi([
  'function getPaymentCount() view returns (uint256)',
  'function getPayments(uint256 offset,uint256 limit) view returns ((address payer,address agent,uint256 amount,string taskType,uint256 timestamp)[])',
]);

const TASK_STATES = ['Created', 'Accepted', 'Completed', 'Approved', 'Disputed', 'Resolved', 'Cancelled'];
function banner(t) { console.log(`\n${'='.repeat(60)}\n  ${t}\n${'='.repeat(60)}`); }
function shortAddr(a) { return `${a.slice(0, 6)}...${a.slice(-4)}`; }
function formatDate(ts) { return (!ts || ts === 0n) ? 'N/A' : new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }

async function main() {
  console.log('\n' + '#'.repeat(60));
  console.log('#   AgentsMarketplace Marketplace — Status Dashboard');
  console.log('#'.repeat(60));
  console.log(`\n  RPC: ${RPC_URL}`);

  const pub = createPublicClient({ chain: xLayer, transport: http() });

  banner('Registered Agents');
  const agentCount = await pub.readContract({ address: AGENT_REGISTRY, abi: registryAbi, functionName: 'getAgentCount' });
  console.log(`  Total agents: ${agentCount}\n`);

  const agentAddresses = new Set();

  if (agentCount > 0n) {
    const { agents, addresses } = await pub.readContract({ address: AGENT_REGISTRY, abi: registryAbi, functionName: 'getAgentsPaginated', args: [0n, agentCount] });
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      addresses[i] && agentAddresses.add(addresses[i]);
      console.log(`  [Agent #${i}]  ${a.name}`);
      console.log(`    Address:     ${addresses[i]}`);
      console.log(`    Price:       ${formatUnits(a.pricePerTask, 6)} USDC`);
      console.log(`    Skills:      [${a.skillTags.join(', ')}]`);
      console.log(`    Active:      ${a.active}\n`);
    }
  }

  banner('Tasks');
  const taskCount = await pub.readContract({ address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'getTaskCount' });
  console.log(`  Total tasks: ${taskCount}\n`);

  if (taskCount > 0n) {
    for (let i = 0n; i < taskCount; i++) {
      const t = await pub.readContract({ address: TASK_MANAGER, abi: taskManagerAbi, functionName: 'getTask', args: [i] });
      agentAddresses.add(t.agent);
      console.log(`  [Task #${i}]  ${TASK_STATES[t.state]}`);
      console.log(`    Client: ${shortAddr(t.client)} | Agent: ${shortAddr(t.agent)}`);
      console.log(`    Payment: ${formatUnits(t.payment, 6)} USDC | Created: ${formatDate(t.createdAt)}\n`);
    }
  }

  banner('Summary');
  console.log(`  Agents: ${agentCount} | Tasks: ${taskCount}`);
  console.log(`  Contracts:`);
  console.log(`    AgentRegistry:    ${AGENT_REGISTRY}`);
  console.log(`    TaskManager:      ${TASK_MANAGER}`);
  console.log(`    ReputationEngine: ${REPUTATION_ENGINE}`);
  console.log(`    NanopayDemo:      ${NANOPAY_DEMO}\n`);
}

main().catch((err) => { console.error('\n[x] Error:', err.shortMessage || err.message); process.exit(1); });
