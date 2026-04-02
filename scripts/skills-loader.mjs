#!/usr/bin/env node
/**
 * skills-loader.mjs — Load SKILL.md files and build Claude system prompt
 *
 * Reads OKX Onchain OS Skills (13) and Uniswap AI Skills (4 core)
 * Extracts essential sections: command index, safety rules, strategy presets
 * Returns a structured system prompt string for Claude tool_use
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// Resolve skill directories — check project-local first, then external repos
const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const XLAYER_ROOT = resolve(PROJECT_ROOT, '..');

// Primary: skills bundled in our repo (works on Railway deployment)
const LOCAL_OKX_DIR = join(PROJECT_ROOT, 'skills', 'okx');
const LOCAL_UNISWAP_DIR = join(PROJECT_ROOT, 'skills', 'uniswap');

// Fallback: external repos (works in local dev)
const EXT_OKX_DIR = join(XLAYER_ROOT, 'onchainos-skills', 'skills');
const EXT_UNISWAP_DIR = join(XLAYER_ROOT, 'uniswap-ai', 'packages', 'plugins');

// OKX Skills to load (ordered by importance)
const OKX_SKILLS = [
  'okx-security',           // CRITICAL: must be first — fail-safe rules
  'okx-dex-swap',           // Core trading with strategy presets
  'okx-agentic-wallet',     // TEE wallet operations
  'okx-x402-payment',       // x402 signing
  'okx-dex-market',         // Price, K-line, PnL
  'okx-dex-signal',         // Smart money signals
  'okx-dex-token',          // Token deep analysis
  'okx-dex-trenches',       // Meme scanning
  'okx-defi-invest',        // DeFi operations
  'okx-defi-portfolio',     // DeFi positions
  'okx-wallet-portfolio',   // Public address balances
  'okx-onchain-gateway',    // TX broadcast/simulate
  'okx-audit-log',          // Audit
];

// Uniswap Skills to load
const UNISWAP_SKILLS = [
  { plugin: 'uniswap-trading', skill: 'swap-integration' },
  { plugin: 'uniswap-driver', skill: 'swap-planner' },
  { plugin: 'uniswap-driver', skill: 'liquidity-planner' },
  { plugin: 'uniswap-trading', skill: 'pay-with-any-token' },
];

/**
 * Extract essential sections from a SKILL.md file
 * Keeps: name, command index, safety rules, execution flow, risk controls
 * Drops: verbose CLI reference, troubleshooting, examples, pre-flight checks
 */
function extractEssentials(content, maxLines = 50) {
  const lines = content.split('\n');
  const essential = [];
  let inSection = false;
  let sectionDepth = 0;
  let lineCount = 0;

  // Extract YAML frontmatter name and description
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const descMatch = content.match(/^description:\s*"?([^"]+)"?$/m);
  if (nameMatch) essential.push(`# ${nameMatch[1]}`);
  if (descMatch) essential.push(descMatch[1].slice(0, 200));
  essential.push('');

  // Sections to keep
  const keepSections = [
    'command index', 'execution flow', 'risk controls', 'safety', 'security',
    'trading parameter presets', 'mev protection', 'amount display',
    'workflow', 'step 1', 'step 2', 'step 3', 'step 4', 'step 5',
    'supported chains', 'fee tier', 'price range', 'risk matrix',
    'global notes', 'important', 'critical',
  ];

  // Sections to skip
  const skipSections = [
    'pre-flight checks', 'cli reference', 'troubleshooting', 'edge cases',
    'input / output examples', 'additional resources', 'faq',
    'confirming response', 'error retry', 'silent / automated mode',
    'wallet export', 'authentication', 'sign message',
  ];

  for (const line of lines) {
    if (lineCount >= maxLines) break;

    // Detect headers
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2].toLowerCase();

      // Check if we should skip this section
      if (skipSections.some(s => title.includes(s))) {
        inSection = false;
        continue;
      }

      // Check if we should keep this section
      if (keepSections.some(s => title.includes(s)) || level <= 2) {
        inSection = true;
        sectionDepth = level;
        essential.push(line);
        lineCount++;
        continue;
      }
    }

    // Keep lines in active sections
    if (inSection) {
      // Skip empty code blocks and verbose content
      if (line.startsWith('```') && !line.includes('bash') && !line.includes('json')) {
        continue;
      }
      essential.push(line);
      lineCount++;
    }
  }

  return essential.join('\n').trim();
}

/**
 * Load and build the complete system prompt from Skills
 */
export function buildSkillPrompt() {
  const sections = [];

  // Header
  sections.push(`You are AgentsMarketplace AI Agent, operating on X Layer (Chain 196).
You have deep knowledge from OKX Onchain OS Skills and Uniswap AI Skills.
Follow these rules strictly when making decisions.

CRITICAL SAFETY RULES:
- Before ANY swap/trade: MUST call security_token_scan first. If result contains action="block", REFUSE the trade.
- Before ANY contract call: MUST call security_tx_scan first. If simulation fails, REFUSE to broadcast.
- Honeypot detected (isHoneyPot=true on buy) → BLOCK immediately.
- High tax rate (>10%) → WARN user, require confirmation.
- Price impact >5% → WARN prominently.
- Quote older than 10 seconds → refresh before executing.

DUAL ENGINE STRATEGY:
- For swap requests on X Layer, use dual_engine_quote to compare OKX DEX Aggregator vs Uniswap.
- Pick the path with better output amount and lower price impact.
- Always tell the user which engine was chosen and why.

ECONOMIC LOOP AWARENESS:
- This Agent earns USDC via x402 payments from users.
- It can invest earnings into DeFi (Uniswap LP, Aave, etc.) to generate yield.
- It can pay other Agents via x402 for specialized services (signals, analysis).
- The cycle: EARN (x402 income) → INVEST (DeFi yield) → PAY (other Agent services) → RE-EARN (better decisions).

REPLY LANGUAGE: Always reply in the same language as the user's question.
`);

  // Load OKX Skills
  sections.push('\n## OKX Onchain OS Skills Knowledge\n');
  for (const skillName of OKX_SKILLS) {
    // Check local bundled copy first, then external repo
    const localPath = join(LOCAL_OKX_DIR, `${skillName}.md`);
    const extPath = join(EXT_OKX_DIR, skillName, 'SKILL.md');
    const skillPath = existsSync(localPath) ? localPath : extPath;
    if (!existsSync(skillPath)) continue;
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const extracted = extractEssentials(content, skillName === 'okx-security' ? 70 : 40);
      if (extracted) {
        sections.push(`### ${skillName}\n${extracted}\n`);
      }
    } catch (err) {
      // Skip unreadable files
    }
  }

  // Load Uniswap Skills
  sections.push('\n## Uniswap AI Skills Knowledge\n');
  for (const { plugin, skill } of UNISWAP_SKILLS) {
    // Check local bundled copy first, then external repo
    const localPath = join(LOCAL_UNISWAP_DIR, `${skill}.md`);
    const extPath = join(EXT_UNISWAP_DIR, plugin, 'skills', skill, 'SKILL.md');
    const skillPath = existsSync(localPath) ? localPath : extPath;
    if (!existsSync(skillPath)) continue;
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const extracted = extractEssentials(content, 35);
      if (extracted) {
        sections.push(`### ${skill}\n${extracted}\n`);
      }
    } catch (err) {
      // Skip unreadable files
    }
  }

  // Trading strategy reference (from okx-dex-swap SKILL.md)
  sections.push(`
## Quick Reference: Trading Parameter Presets

| Scenario | Slippage | Gas Level |
|----------|----------|-----------|
| Meme / low-cap / new tokens | autoSlippage (5-20%) | fast |
| Mainstream (BTC/ETH/SOL) | autoSlippage (0.5-1%) | average |
| Stablecoin pairs | autoSlippage (0.1-0.3%) | average |
| Large trades (>$1000, impact>=10%) | autoSlippage | average |

## Quick Reference: Uniswap LP Fee Tiers

| Fee | Tick Spacing | Best For |
|-----|-------------|----------|
| 0.01% (100) | 1 | Stablecoin pairs |
| 0.05% (500) | 10 | Correlated pairs (ETH/stETH) |
| 0.30% (3000) | 60 | Most pairs (default) |
| 1.00% (10000) | 200 | Exotic / volatile pairs |

## Quick Reference: LP Price Range

| Pair Type | Default Range |
|-----------|---------------|
| Stablecoin | ±0.5-1% |
| Correlated (ETH/stETH) | ±2-5% |
| Major (ETH/USDC) | ±10-20% |
| Volatile | ±30-50% or Full Range |
`);

  const prompt = sections.join('\n');

  // Log token estimate
  const estimatedTokens = Math.round(prompt.length / 4);
  console.log(`[skills-loader] System prompt: ~${estimatedTokens} tokens from ${OKX_SKILLS.length} OKX + ${UNISWAP_SKILLS.length} Uniswap Skills`);

  return prompt;
}

// CLI test mode
if (process.argv[1] && process.argv[1].includes('skills-loader')) {
  const prompt = buildSkillPrompt();
  console.log('\n--- SYSTEM PROMPT PREVIEW (first 2000 chars) ---\n');
  console.log(prompt.slice(0, 2000));
  console.log(`\n--- Total length: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens) ---`);
}
