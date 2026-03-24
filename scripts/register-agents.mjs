#!/usr/bin/env node
/**
 * register-agents.mjs — Register demo AI agents on AgentsMarketplace Marketplace
 *
 * Usage:  PRIVATE_KEY=0x... node scripts/register-agents.mjs
 */

import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL = 'https://rpc.xlayer.tech';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('Set PRIVATE_KEY environment variable.');
  process.exit(1);
}
const AGENT_REGISTRY = '0x7337a8963Dc7Cf0644f9423bBE397b3D0f97ACa1';

// ── X Layer chain definition ──────────────────────────────────────────────────
const xLayer = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// ── ABI ───────────────────────────────────────────────────────────────────────
const registryAbi = parseAbi([
  'function registerAgent(string _name, string _description, string _endpoint, uint256 _pricePerTask, string[] _skillTags)',
  'function isRegistered(address _agent) view returns (bool)',
  'function getAgent(address _agent) view returns ((string name, string description, string endpoint, uint256 pricePerTask, string[] skillTags, bool active, uint256 registeredAt, uint256 totalTasks, uint256 totalEarned))',
  'event AgentRegistered(address indexed agent, string name)',
]);

const DEMO_AGENTS = [
  { name: 'DataAnalyst-AI', description: 'Data analysis and visualization', endpoint: 'https://api.agentsmarketplace.app/data-analyst', price: 500_000n, skills: ['data', 'analytics', 'visualization'] },
  { name: 'TranslateBot', description: 'Multi-language translation service', endpoint: 'https://api.agentsmarketplace.app/translate', price: 100_000n, skills: ['translation', 'nlp', 'language'] },
  { name: 'CodeReviewer', description: 'Smart contract code review', endpoint: 'https://api.agentsmarketplace.app/code-review', price: 1_000_000n, skills: ['solidity', 'audit', 'security'] },
];

async function main() {
  console.log('='.repeat(60));
  console.log('  AgentsMarketplace Marketplace — Register Demo Agents');
  console.log('='.repeat(60));

  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log(`\n[*] Wallet: ${account.address}`);

  const publicClient = createPublicClient({ chain: xLayer, transport: http() });
  const walletClient = createWalletClient({ account, chain: xLayer, transport: http() });

  const alreadyRegistered = await publicClient.readContract({
    address: AGENT_REGISTRY, abi: registryAbi, functionName: 'isRegistered', args: [account.address],
  });

  if (alreadyRegistered) {
    console.log('\n[!] This wallet is already registered as an agent.');
    const agent = await publicClient.readContract({
      address: AGENT_REGISTRY, abi: registryAbi, functionName: 'getAgent', args: [account.address],
    });
    console.log(`    Name: ${agent.name}`);
    console.log(`    Price: ${Number(agent.pricePerTask) / 1e6} USDC`);
    console.log(`    Skills: ${agent.skillTags.join(', ')}`);
  }

  if (!alreadyRegistered) {
    const agent = DEMO_AGENTS[0];
    console.log(`\n[>] Registering agent: "${agent.name}"`);
    try {
      const hash = await walletClient.writeContract({
        address: AGENT_REGISTRY, abi: registryAbi, functionName: 'registerAgent',
        args: [agent.name, agent.description, agent.endpoint, agent.price, agent.skills],
      });
      console.log(`    Tx: ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`    [+] Confirmed in block ${receipt.blockNumber}`);
    } catch (err) {
      console.error(`    [x] Failed: ${err.shortMessage || err.message}`);
    }
  }

  console.log('\n--- Additional agents (require separate wallets) ---');
  for (const agent of DEMO_AGENTS.slice(1)) {
    console.log(`  - ${agent.name}: ${agent.description} @ ${Number(agent.price) / 1e6} USDC`);
  }
  console.log('\n' + '='.repeat(60));
}

main().catch((err) => { console.error('\n[x] Fatal:', err.message); process.exit(1); });
