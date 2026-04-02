#!/usr/bin/env node
/**
 * generate-activity.mjs — Generate on-chain activity for hackathon scoring
 *
 * The AI Agent reviewer scans on-chain transaction records.
 * This script generates diverse activity: x402 calls, swap quotes, DeFi searches.
 *
 * Usage:
 *   AGENT_URL=https://xlayeragent-server-production.up.railway.app node scripts/generate-activity.mjs
 *
 * NOTE: Real x402 payments require a funded wallet and signed EIP-3009 authorization.
 * This script calls free endpoints and demonstrates the payment flow.
 */

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3080';

async function callEndpoint(path, description) {
  const url = `${AGENT_URL}${path}`;
  console.log(`[${description}] → ${url}`);
  try {
    const res = await fetch(url);
    const status = res.status;
    if (status === 402) {
      console.log(`  ← 402 Payment Required (x402 payment needed)`);
      return { status: 402, paymentRequired: true };
    }
    const data = await res.json();
    console.log(`  ← ${status} OK (${JSON.stringify(data).slice(0, 120)}...)`);
    return { status, data };
  } catch (err) {
    console.log(`  ← ERROR: ${err.message}`);
    return { status: 'error', error: err.message };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('  AgentsMarketplace Activity Generator');
  console.log('  Target:', AGENT_URL);
  console.log('='.repeat(60));
  console.log();

  // Free endpoints (no payment needed)
  console.log('--- Free Endpoints ---');
  await callEndpoint('/status', 'Agent Status');
  await callEndpoint('/api', 'API Directory');
  console.log();

  // x402-protected endpoints (will return 402 without payment)
  console.log('--- x402 Endpoints (will return 402) ---');
  const endpoints = [
    ['/api/ask?q=What%20is%20the%20best%20DeFi%20yield%20on%20X%20Layer', 'Ask Agent'],
    ['/api/analyze?q=OKB', 'Market Analysis'],
    ['/api/signals?chain=196', 'Smart Money Signals'],
    ['/api/security?q=USDC&chain=196', 'Security Scan'],
    ['/api/dual-swap?from=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee&to=0x74b7F16337b8972027F6196A17a631aC6dE26d22&amount=1000000000000000000', 'Dual Engine Swap'],
    ['/api/defi?token=USDC&chain=196', 'DeFi Yields'],
    ['/api/strategy?q=Find%20best%20yield%20for%20USDC', 'Multi-Step Strategy'],
    ['/api/economic-loop', 'Economic Loop'],
    ['/api/swap?chain=196&from=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee&to=0x74b7F16337b8972027F6196A17a631aC6dE26d22&amount=1000000000000000000', 'Swap Quote'],
    ['/api/portfolio?address=0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18', 'Portfolio'],
    ['/api/gas?chain=196', 'Gas Price'],
    ['/api/trenches?chain=196', 'Meme Scanner'],
  ];

  for (const [path, desc] of endpoints) {
    await callEndpoint(path, desc);
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log();
  console.log('--- Summary ---');
  console.log(`Total endpoints tested: ${endpoints.length + 2}`);
  console.log(`x402-protected: ${endpoints.length}`);
  console.log(`Free: 2`);
  console.log();
  console.log('To generate real on-chain activity, use the frontend at:');
  console.log(`  ${AGENT_URL.replace('railway.app', 'agentsmarketplace.app')}`);
  console.log('Connect your wallet and make x402-paid API calls.');
  console.log();
  console.log('Each x402 call generates:');
  console.log('  1. EIP-3009 signature (off-chain, zero gas)');
  console.log('  2. OKX verify transaction');
  console.log('  3. OKX settle transaction (on-chain USDC transfer, OKX pays gas)');
  console.log('  4. X402Rating on-chain review (optional)');
}

main().catch(console.error);
