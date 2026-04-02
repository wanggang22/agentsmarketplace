#!/usr/bin/env node
/**
 * agentic-wallet.mjs — OKX Agentic Wallet wrapper (TEE-based)
 *
 * Wraps onchainos CLI for programmatic wallet operations.
 * Private key lives in TEE (Trusted Execution Environment) — never exposed.
 * Falls back gracefully if onchainos is not available.
 *
 * All functions return parsed JSON or null on error.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execAsync = promisify(execFile);

// Resolve onchainos binary path
const ONCHAINOS_PATHS = [
  process.env.ONCHAINOS_PATH,
  `${process.env.HOME || process.env.USERPROFILE}/.local/bin/onchainos`,
  `${process.env.HOME || process.env.USERPROFILE}/.local/bin/onchainos.exe`,
  '/usr/local/bin/onchainos',
];

let ONCHAINOS_BIN = null;
for (const p of ONCHAINOS_PATHS) {
  if (p && existsSync(p)) { ONCHAINOS_BIN = p; break; }
}

/**
 * Execute an onchainos command and return parsed JSON result
 */
async function onchainos(...args) {
  if (!ONCHAINOS_BIN) return { ok: false, error: 'onchainos binary not found' };

  try {
    const { stdout, stderr } = await execAsync(ONCHAINOS_BIN, args, {
      timeout: 30000,
      env: {
        ...process.env,
        // Ensure OKX credentials are passed
        OKX_API_KEY: process.env.OKX_API_KEY || '',
        OKX_SECRET_KEY: process.env.OKX_SECRET_KEY || '',
        OKX_PASSPHRASE: process.env.OKX_PASSPHRASE || '',
      },
    });

    try {
      return JSON.parse(stdout.trim());
    } catch {
      return { ok: true, raw: stdout.trim() };
    }
  } catch (err) {
    // Exit code 2 = confirming response (needs user confirmation)
    if (err.code === 2 || err.status === 2) {
      try { return JSON.parse(err.stdout?.trim()); } catch {}
    }
    const errOutput = err.stdout || err.stderr || err.message;
    try { return JSON.parse(errOutput.trim()); } catch {}
    return { ok: false, error: errOutput?.slice(0, 500) || err.message };
  }
}

// ── Account Management ──────────────────────────────────────────────────────

/** Silent API Key login (non-interactive) */
export async function walletLogin() {
  return onchainos('wallet', 'login');
}

/** Check login status */
export async function walletStatus() {
  return onchainos('wallet', 'status');
}

/** Get wallet addresses (grouped by chain) */
export async function walletAddresses(chainId) {
  const args = ['wallet', 'addresses'];
  if (chainId) args.push('--chain', String(chainId));
  return onchainos(...args);
}

/** Logout */
export async function walletLogout() {
  return onchainos('wallet', 'logout');
}

// ── Balance ─────────────────────────────────────────────────────────────────

/** Get wallet balance (all chains or specific chain) */
export async function walletBalance(chainId) {
  const args = ['wallet', 'balance'];
  if (chainId) args.push('--chain', String(chainId));
  return onchainos(...args);
}

/** Get balance for specific token */
export async function walletTokenBalance(chainId, tokenAddress) {
  return onchainos('wallet', 'balance', '--chain', String(chainId), '--token-address', tokenAddress);
}

// ── Transactions ────────────────────────────────────────────────────────────

/** Send native or ERC-20 tokens */
export async function walletSend({ to, amount, chain, contractToken, force = false }) {
  const args = ['wallet', 'send', '--readable-amount', String(amount), '--receipt', to, '--chain', String(chain)];
  if (contractToken) args.push('--contract-token', contractToken);
  if (force) args.push('--force');
  return onchainos(...args);
}

/** Call a smart contract */
export async function walletContractCall({ to, chain, inputData, amt = '0', force = false }) {
  const args = ['wallet', 'contract-call', '--to', to, '--chain', String(chain), '--input-data', inputData];
  if (amt !== '0') args.push('--amt', amt);
  if (force) args.push('--force');
  return onchainos(...args);
}

/** Sign a message (personalSign or EIP-712) */
export async function walletSignMessage({ chain, from, message, type = 'personal', force = false }) {
  const args = ['wallet', 'sign-message', '--chain', String(chain), '--from', from, '--message', message];
  if (type === 'eip712') args.push('--type', 'eip712');
  if (force) args.push('--force');
  return onchainos(...args);
}

// ── Transaction History ─────────────────────────────────────────────────────

/** Get transaction history */
export async function walletHistory({ chain, limit = '20' } = {}) {
  const args = ['wallet', 'history'];
  if (chain) args.push('--chain', String(chain));
  args.push('--limit', String(limit));
  return onchainos(...args);
}

// ── x402 Payment (TEE signing) ──────────────────────────────────────────────

/** Sign an x402 payment via TEE — returns { signature, authorization } */
export async function x402Pay({ network, amount, payTo, asset, maxTimeoutSeconds = 300 }) {
  return onchainos('payment', 'x402-pay',
    '--network', network,
    '--amount', String(amount),
    '--pay-to', payTo,
    '--asset', asset,
    '--max-timeout-seconds', String(maxTimeoutSeconds),
  );
}

// ── Swap (one-shot via onchainos) ───────────────────────────────────────────

/** Execute a swap (quote → approve → sign → broadcast in one command) */
export async function swapExecute({ from, to, amount, chain = 'xlayer', slippage, gasLevel = 'average' }) {
  const args = ['swap', 'execute', '--from', from, '--to', to, '--readable-amount', String(amount), '--chain', chain, '--gas-level', gasLevel];
  if (slippage) args.push('--slippage', String(slippage));
  return onchainos(...args);
}

/** Get a swap quote (read-only, no execution) */
export async function swapQuote({ from, to, amount, chain = 'xlayer' }) {
  return onchainos('swap', 'quote', '--from', from, '--to', to, '--readable-amount', String(amount), '--chain', chain);
}

// ── DeFi via onchainos ──────────────────────────────────────────────────────

/** Search DeFi products */
export async function defiList({ chain = 'xlayer', token } = {}) {
  const args = ['defi', 'list', '--chain', chain];
  if (token) args.push('--token', token);
  return onchainos(...args);
}

// ── Initialization ──────────────────────────────────────────────────────────

/** Initialize Agentic Wallet: login + get addresses + balance */
export async function initAgenticWallet() {
  if (!ONCHAINOS_BIN) {
    return { available: false, reason: 'onchainos binary not found' };
  }

  // Check if already logged in
  let status = await walletStatus();
  if (!status?.data?.loggedIn) {
    // Try API Key login
    const loginResult = await walletLogin();
    if (!loginResult?.ok && !loginResult?.data) {
      return { available: false, reason: `Login failed: ${loginResult?.error || 'unknown'}` };
    }
    status = await walletStatus();
  }

  if (!status?.data?.loggedIn) {
    return { available: false, reason: 'Failed to login (check OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE)' };
  }

  // Get addresses
  const addresses = await walletAddresses(196);
  const balance = await walletBalance(196);

  return {
    available: true,
    accountName: status.data.currentAccountName,
    accountId: status.data.currentAccountId,
    addresses: addresses?.data || null,
    balance: balance?.data || null,
  };
}

/** Check if Agentic Wallet is available */
export function isAvailable() {
  return !!ONCHAINOS_BIN;
}

export { ONCHAINOS_BIN };

// CLI test mode
if (process.argv[1]?.includes('agentic-wallet')) {
  console.log(`onchainos binary: ${ONCHAINOS_BIN || 'NOT FOUND'}`);
  const status = await walletStatus();
  console.log('Wallet status:', JSON.stringify(status, null, 2));

  if (status?.data?.loggedIn) {
    const bal = await walletBalance(196);
    console.log('X Layer balance:', JSON.stringify(bal, null, 2));
  } else {
    console.log('Not logged in. Set OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE and run walletLogin()');
  }
}
