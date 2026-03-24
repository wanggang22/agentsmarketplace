// ============================================================================
// AgentsMarketplace SDK
// Turn any script into an AgentsMarketplace marketplace agent in minutes.
//
// Usage:
//   import { AgentsMarketplace } from './xlayeragent-sdk.mjs';
//   const agent = new AgentsMarketplace({ privateKey: '0x...' });
//   await agent.register({ name: 'MyAgent', ... });
//   agent.onTask(async (task) => { return 'result'; });
//   await agent.start();
//
// Requirements: viem (npm install viem)
// Target chain: X Layer (Chain ID 196)
// ============================================================================

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseUnits,
  formatUnits,
  keccak256,
  toHex,
  getContract,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// X Layer chain definition
// ---------------------------------------------------------------------------

const xLayer = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.xlayer.tech'] },
  },
  blockExplorers: {
    default: { name: 'OKX Explorer', url: 'https://www.okx.com/web3/explorer/xlayer' },
  },
});

// ---------------------------------------------------------------------------
// Default contract addresses (X Layer) — filled after deployment
// ---------------------------------------------------------------------------

const DEFAULT_ADDRESSES = {
  AgentRegistry:    '0x7337a8963Dc7Cf0644f9423bBE397b3D0f97ACa1',
  TaskManager:      '0x599e23D6073426eBe357d03056258eEAa217e01D',
  ReputationEngine: '0x3bf87bf49141B014e4Eef71A661988624c1af29F',
  NanopayDemo:      '0x850747924481c0B1Ad3Eca2f60810Ff91B72b6ef',
  USDC:             '0x74b7F16337b8972027F6196A17a631aC6dE26d22',
};

// ---------------------------------------------------------------------------
// Contract ABIs (minimal)
// ---------------------------------------------------------------------------

const AGENT_REGISTRY_ABI = [
  {
    name: 'registerAgent', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: '_name', type: 'string' }, { name: '_description', type: 'string' },
      { name: '_endpoint', type: 'string' }, { name: '_pricePerTask', type: 'uint256' },
      { name: '_skillTags', type: 'string[]' },
    ],
    outputs: [],
  },
  {
    name: 'updateAgent', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: '_name', type: 'string' }, { name: '_description', type: 'string' },
      { name: '_endpoint', type: 'string' }, { name: '_pricePerTask', type: 'uint256' },
      { name: '_skillTags', type: 'string[]' },
    ],
    outputs: [],
  },
  { name: 'deactivateAgent', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'activateAgent', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    name: 'getAgent', type: 'function', stateMutability: 'view',
    inputs: [{ name: '_agent', type: 'address' }],
    outputs: [{
      name: '', type: 'tuple',
      components: [
        { name: 'name', type: 'string' }, { name: 'description', type: 'string' },
        { name: 'endpoint', type: 'string' }, { name: 'pricePerTask', type: 'uint256' },
        { name: 'skillTags', type: 'string[]' }, { name: 'active', type: 'bool' },
        { name: 'registeredAt', type: 'uint256' }, { name: 'totalTasks', type: 'uint256' },
        { name: 'totalEarned', type: 'uint256' },
      ],
    }],
  },
  {
    name: 'isRegistered', type: 'function', stateMutability: 'view',
    inputs: [{ name: '_agent', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
];

const TASK_MANAGER_ABI = [
  { name: 'acceptTask', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'taskId', type: 'uint256' }], outputs: [] },
  { name: 'completeTask', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'taskId', type: 'uint256' }, { name: 'resultHash', type: 'string' }], outputs: [] },
  {
    name: 'getTask', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [{
      name: '', type: 'tuple',
      components: [
        { name: 'client', type: 'address' }, { name: 'agent', type: 'address' },
        { name: 'description', type: 'string' }, { name: 'payment', type: 'uint256' },
        { name: 'resultHash', type: 'string' }, { name: 'state', type: 'uint8' },
        { name: 'createdAt', type: 'uint256' }, { name: 'acceptedAt', type: 'uint256' },
        { name: 'completedAt', type: 'uint256' }, { name: 'disputedAt', type: 'uint256' },
      ],
    }],
  },
  { name: 'getTaskCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'getTasksByAgent', type: 'function', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ name: '', type: 'uint256[]' }] },
];

const REPUTATION_ENGINE_ABI = [
  {
    name: 'getReputation', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [{ name: 'totalTasks', type: 'uint256' }, { name: 'avgRatingX100', type: 'uint256' }, { name: 'totalRatings', type: 'uint256' }],
  },
  {
    name: 'getReviews', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'agent', type: 'address' }, { name: 'offset', type: 'uint256' }, { name: 'limit', type: 'uint256' }],
    outputs: [{
      name: '', type: 'tuple[]',
      components: [
        { name: 'taskId', type: 'uint256' }, { name: 'reviewer', type: 'address' },
        { name: 'rating', type: 'uint8' }, { name: 'comment', type: 'string' },
        { name: 'timestamp', type: 'uint256' },
      ],
    }],
  },
];

const NANOPAY_DEMO_ABI = [
  {
    name: 'recordPayment', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'agent', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'taskType', type: 'string' }],
    outputs: [],
  },
];

// ---------------------------------------------------------------------------
// Task states
// ---------------------------------------------------------------------------

const TaskState = Object.freeze({
  Created: 0, InProgress: 1, Completed: 2, Approved: 3, Disputed: 4, Resolved: 5, Cancelled: 6,
});

const TaskStateName = Object.freeze(
  Object.fromEntries(Object.entries(TaskState).map(([k, v]) => [v, k]))
);

// ---------------------------------------------------------------------------
// AgentsMarketplace
// ---------------------------------------------------------------------------

export class AgentsMarketplace extends EventEmitter {
  constructor({ privateKey, rpcUrl, addresses, pollInterval } = {}) {
    super();
    if (!privateKey) throw new Error('AgentsMarketplace: privateKey is required');

    this._addresses = { ...DEFAULT_ADDRESSES, ...addresses };
    this._account = privateKeyToAccount(privateKey);

    const chain = rpcUrl
      ? { ...xLayer, rpcUrls: { default: { http: [rpcUrl] } } }
      : xLayer;

    this._publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl || xLayer.rpcUrls.default.http[0]),
    });

    this._walletClient = createWalletClient({
      account: this._account,
      chain,
      transport: http(rpcUrl || xLayer.rpcUrls.default.http[0]),
    });

    this._registry = getContract({
      address: this._addresses.AgentRegistry,
      abi: AGENT_REGISTRY_ABI,
      client: { public: this._publicClient, wallet: this._walletClient },
    });

    this._taskManager = getContract({
      address: this._addresses.TaskManager,
      abi: TASK_MANAGER_ABI,
      client: { public: this._publicClient, wallet: this._walletClient },
    });

    this._reputation = getContract({
      address: this._addresses.ReputationEngine,
      abi: REPUTATION_ENGINE_ABI,
      client: { public: this._publicClient, wallet: this._walletClient },
    });

    this._nanopay = getContract({
      address: this._addresses.NanopayDemo,
      abi: NANOPAY_DEMO_ABI,
      client: { public: this._publicClient, wallet: this._walletClient },
    });

    this._taskHandler = null;
    this._pollTimer = null;
    this._pollInterval = pollInterval || 5000;
    this._processedTasks = new Set();
    this._running = false;
  }

  get address() { return this._account.address; }
  get isRunning() { return this._running; }
  static get TaskState() { return TaskState; }
  static get TaskStateName() { return TaskStateName; }

  async register({ name, description, endpoint, pricePerTask, skills = [] }) {
    if (!name || !endpoint) throw new Error('AgentsMarketplace: name and endpoint are required');
    const priceWei = parseUnits(String(pricePerTask || 0), 6);
    const hash = await this._withRetry(() =>
      this._registry.write.registerAgent([name, description || '', endpoint, priceWei, skills])
    );
    this._log(`Registered as "${name}" — tx: ${hash}`);
    return hash;
  }

  async updateProfile({ name, description, endpoint, pricePerTask, skills = [] }) {
    const priceWei = parseUnits(String(pricePerTask || 0), 6);
    const hash = await this._withRetry(() =>
      this._registry.write.updateAgent([name, description || '', endpoint, priceWei, skills])
    );
    this._log(`Profile updated — tx: ${hash}`);
    return hash;
  }

  async deactivate() {
    const hash = await this._withRetry(() => this._registry.write.deactivateAgent());
    this._log(`Agent deactivated — tx: ${hash}`);
    return hash;
  }

  async activate() {
    const hash = await this._withRetry(() => this._registry.write.activateAgent());
    this._log(`Agent activated — tx: ${hash}`);
    return hash;
  }

  async isRegistered() {
    return this._withRetry(() => this._registry.read.isRegistered([this.address]));
  }

  async getProfile() {
    const raw = await this._withRetry(() => this._registry.read.getAgent([this.address]));
    return {
      name: raw.name, description: raw.description, endpoint: raw.endpoint,
      pricePerTask: Number(formatUnits(raw.pricePerTask, 6)),
      skills: raw.skillTags, active: raw.active,
      registeredAt: Number(raw.registeredAt),
      totalTasks: Number(raw.totalTasks),
      totalEarned: Number(formatUnits(raw.totalEarned, 6)),
    };
  }

  onTask(handler) {
    if (typeof handler !== 'function') throw new Error('AgentsMarketplace: onTask handler must be a function');
    this._taskHandler = handler;
  }

  async start() {
    if (this._running) { this._log('Already running'); return; }
    if (!this._taskHandler) throw new Error('AgentsMarketplace: call onTask(handler) before start()');
    this._running = true;
    this._log(`Listening for tasks (poll every ${this._pollInterval}ms)...`);
    await this._poll();
    this._pollTimer = setInterval(() => this._poll(), this._pollInterval);
  }

  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this._running = false;
    this._log('Stopped listening for tasks');
  }

  async getMyTaskIds() { return this._withRetry(() => this._taskManager.read.getTasksByAgent([this.address])); }

  async getMyTasks() {
    const ids = await this.getMyTaskIds();
    const tasks = [];
    for (const id of ids) { tasks.push(await this.getTask(id)); }
    return tasks;
  }

  async getTask(taskId) {
    const raw = await this._withRetry(() => this._taskManager.read.getTask([BigInt(taskId)]));
    return {
      id: BigInt(taskId), client: raw.client, agent: raw.agent,
      description: raw.description, payment: Number(formatUnits(raw.payment, 6)),
      paymentRaw: raw.payment, resultHash: raw.resultHash,
      state: Number(raw.state), stateName: TaskStateName[Number(raw.state)],
      createdAt: Number(raw.createdAt), acceptedAt: Number(raw.acceptedAt),
      completedAt: Number(raw.completedAt), disputedAt: Number(raw.disputedAt),
    };
  }

  async acceptTask(taskId) {
    const hash = await this._withRetry(() => this._taskManager.write.acceptTask([BigInt(taskId)]));
    this._log(`Accepted task #${taskId} — tx: ${hash}`);
    this.emit('task:accepted', { taskId: BigInt(taskId), txHash: hash });
    return hash;
  }

  async completeTask(taskId, resultHash) {
    const hash = await this._withRetry(() => this._taskManager.write.completeTask([BigInt(taskId), resultHash]));
    this._log(`Completed task #${taskId} — tx: ${hash}`);
    this.emit('task:completed', { taskId: BigInt(taskId), resultHash, txHash: hash });
    return hash;
  }

  async getReputation() {
    const [totalTasks, avgRatingX100, totalRatings] = await this._withRetry(() =>
      this._reputation.read.getReputation([this.address])
    );
    return { totalTasks: Number(totalTasks), avgRating: Number(avgRatingX100) / 100, totalRatings: Number(totalRatings) };
  }

  async getReviews(offset = 0, limit = 10) {
    const raw = await this._withRetry(() =>
      this._reputation.read.getReviews([this.address, BigInt(offset), BigInt(limit)])
    );
    return raw.map((r) => ({
      taskId: Number(r.taskId), reviewer: r.reviewer, rating: Number(r.rating),
      comment: r.comment, timestamp: Number(r.timestamp),
    }));
  }

  async recordPayment({ agent, amount, taskType }) {
    const agentAddr = agent || this.address;
    const amountWei = parseUnits(String(amount), 6);
    const hash = await this._withRetry(() =>
      this._nanopay.write.recordPayment([agentAddr, amountWei, taskType])
    );
    this._log(`Recorded payment of ${amount} USDC — tx: ${hash}`);
    return hash;
  }

  // -- Internal --

  async _poll() {
    try {
      const taskIds = await this.getMyTaskIds();
      for (const id of taskIds) {
        const idStr = id.toString();
        if (this._processedTasks.has(idStr)) continue;
        let task;
        try { task = await this.getTask(id); } catch (err) { this._log(`Failed to fetch task #${id}: ${err.message}`); continue; }
        if (task.state !== TaskState.Created) {
          if (task.state !== TaskState.InProgress) this._processedTasks.add(idStr);
          continue;
        }
        this.emit('task:new', task);
        this._log(`New task #${id}: "${task.description}" (${task.payment} USDC)`);
        this._processedTasks.add(idStr);
        this._processTask(task).catch((err) => {
          this._log(`Error processing task #${id}: ${err.message}`);
          this.emit('task:error', { task, error: err });
        });
      }
    } catch (err) { this._log(`Poll error: ${err.message}`); }
  }

  async _processTask(task) {
    const taskId = task.id;
    try { await this.acceptTask(taskId); } catch (err) {
      if (this._isContractRevert(err)) { this._log(`Skipping task #${taskId}: ${err.message}`); return; }
      throw err;
    }
    let result;
    try { result = await this._taskHandler({ id: taskId, client: task.client, description: task.description, payment: task.payment }); } catch (err) {
      this._log(`Handler error for task #${taskId}: ${err.message}`);
      this.emit('task:error', { task, error: err, phase: 'handler' });
      return;
    }
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    try { await this.completeTask(taskId, resultStr); } catch (err) {
      if (this._isContractRevert(err)) { this._log(`Skipping task #${taskId}: ${err.message}`); return; }
      throw err;
    }
    try { await this.recordPayment({ agent: this.address, amount: task.payment, taskType: task.description.slice(0, 100) }); } catch (err) {
      this._log(`Warning: nanopayment recording failed: ${err.message}`);
    }
    this._log(`Task #${taskId} fully processed`);
  }

  async _withRetry(fn) {
    try { return await fn(); } catch (err) {
      if (this._isContractRevert(err)) throw err;
      this._log(`RPC error, retrying once: ${err.message}`);
      await this._sleep(1000);
      return await fn();
    }
  }

  _isContractRevert(err) {
    const msg = err?.message || '';
    return msg.includes('revert') || msg.includes('execution reverted') || msg.includes('CALL_EXCEPTION') || err?.code === 'CALL_EXCEPTION';
  }

  _log(msg) { const ts = new Date().toISOString().slice(11, 19); console.log(`[AgentsMarketplace ${ts}] ${msg}`); }
  _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
}

export { TaskState, TaskStateName, DEFAULT_ADDRESSES, xLayer };
