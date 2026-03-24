// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
// TaskManager.sol — Task creation, escrow, and lifecycle management
// Target: X Layer (Chain ID 196)
// =============================================================================

// Minimal IERC20 interface (USDC on X Layer, 6 decimals)
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IAgentRegistry {
    function isAgentActive(address agent) external view returns (bool);
    function incrementTasks(address agent, uint256 earned) external;
}

interface IReputationEngine {
    function rateAgent(address agent, uint256 taskId, uint8 rating, string calldata comment, address reviewer) external;
}

// =============================================================================
// TaskManager
// =============================================================================
contract TaskManager {

    /// @notice USDC token on X Layer (6 decimals).
    address public constant USDC_TOKEN = 0x74b7F16337b8972027F6196A17a631aC6dE26d22;

    uint256 public constant DISPUTE_TIMEOUT = 24 hours;
    uint256 public constant ACCEPT_TIMEOUT = 48 hours;
    uint256 public constant AUTO_APPROVE_TIMEOUT = 72 hours;
    uint256 public constant EMERGENCY_TIMEOUT = 30 days;

    enum TaskState {
        Created,
        InProgress,
        Completed,
        Approved,
        Disputed,
        Resolved,
        Cancelled
    }

    struct Task {
        address client;
        address agent;
        string  description;
        uint256 payment;
        string  resultHash;
        TaskState state;
        uint256 createdAt;
        uint256 acceptedAt;
        uint256 completedAt;
        uint256 disputedAt;
    }

    address public owner;
    address public pendingOwner;
    IAgentRegistry public agentRegistry;
    IReputationEngine public reputationEngine;
    Task[] public tasks;
    mapping(address => uint256[]) private _clientTasks;
    mapping(address => uint256[]) private _agentTasks;
    mapping(uint256 => bool) private _taskRated;
    uint256 public totalVolume;
    uint256 public totalApprovedTasks;

    event TaskCreated(uint256 indexed taskId, address indexed client, address indexed agent, uint256 payment);
    event TaskAccepted(uint256 indexed taskId, address indexed agent);
    event TaskCompleted(uint256 indexed taskId, address indexed agent, string resultHash);
    event TaskApproved(uint256 indexed taskId, address indexed client, address indexed agent, uint256 payment);
    event TaskDisputed(uint256 indexed taskId, address indexed client);
    event TaskResolved(uint256 indexed taskId, address indexed agent, uint256 payment);
    event TaskCancelled(uint256 indexed taskId, address indexed client, uint256 refund);
    event TaskAutoApproved(uint256 indexed taskId, address indexed agent, uint256 payment);
    event DisputeResolvedByOwner(uint256 indexed taskId, bool favorAgent);
    event EmergencyWithdraw(uint256 indexed taskId, uint256 amount);
    event ReputationEngineUpdated(address indexed oldAddr, address indexed newAddr);
    event AgentRegistryUpdated(address indexed oldAddr, address indexed newAddr);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "TaskManager: caller is not the owner");
        _;
    }

    constructor(address _agentRegistry) {
        require(_agentRegistry != address(0), "TaskManager: zero address registry");
        owner = msg.sender;
        agentRegistry = IAgentRegistry(_agentRegistry);
    }

    function createTask(
        address agent,
        string calldata description,
        uint256 payment
    ) external returns (uint256 taskId) {
        require(agent != address(0), "TaskManager: zero address agent");
        require(msg.sender != agent, "TaskManager: cannot hire yourself");
        require(payment > 0, "TaskManager: payment must be > 0");
        require(agentRegistry.isAgentActive(agent), "TaskManager: agent not registered or inactive");

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(
            usdc.transferFrom(msg.sender, address(this), payment),
            "TaskManager: USDC transfer failed"
        );

        taskId = tasks.length;
        tasks.push(Task({
            client:      msg.sender,
            agent:       agent,
            description: description,
            payment:     payment,
            resultHash:  "",
            state:       TaskState.Created,
            createdAt:   block.timestamp,
            acceptedAt:  0,
            completedAt: 0,
            disputedAt:  0
        }));

        _clientTasks[msg.sender].push(taskId);
        _agentTasks[agent].push(taskId);

        emit TaskCreated(taskId, msg.sender, agent, payment);
    }

    function acceptTask(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        require(msg.sender == t.agent, "TaskManager: caller is not the assigned agent");
        require(t.state == TaskState.Created, "TaskManager: task is not in Created state");

        t.state = TaskState.InProgress;
        t.acceptedAt = block.timestamp;

        emit TaskAccepted(taskId, msg.sender);
    }

    function completeTask(uint256 taskId, string calldata resultHash) external {
        Task storage t = _getTask(taskId);
        require(msg.sender == t.agent, "TaskManager: caller is not the assigned agent");
        require(t.state == TaskState.InProgress, "TaskManager: task is not InProgress");

        t.resultHash = resultHash;
        t.state = TaskState.Completed;
        t.completedAt = block.timestamp;

        emit TaskCompleted(taskId, msg.sender, resultHash);
    }

    function approveTask(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        require(msg.sender == t.client, "TaskManager: caller is not the client");
        require(t.state == TaskState.Completed, "TaskManager: task is not Completed");

        t.state = TaskState.Approved;

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transfer(t.agent, t.payment), "TaskManager: USDC transfer to agent failed");

        agentRegistry.incrementTasks(t.agent, t.payment);

        totalVolume += t.payment;
        totalApprovedTasks += 1;

        emit TaskApproved(taskId, msg.sender, t.agent, t.payment);
    }

    function autoApproveTask(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        require(t.state == TaskState.Completed, "TaskManager: task is not Completed");
        require(
            block.timestamp >= t.completedAt + AUTO_APPROVE_TIMEOUT,
            "TaskManager: auto-approve timeout not reached"
        );

        t.state = TaskState.Approved;

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transfer(t.agent, t.payment), "TaskManager: USDC transfer to agent failed");

        agentRegistry.incrementTasks(t.agent, t.payment);

        totalVolume += t.payment;
        totalApprovedTasks += 1;

        emit TaskAutoApproved(taskId, t.agent, t.payment);
    }

    function rateAgent(uint256 taskId, uint8 rating, string calldata comment) external {
        Task storage t = _getTask(taskId);
        require(msg.sender == t.client, "TaskManager: caller is not the client");
        require(t.state == TaskState.Approved || t.state == TaskState.Resolved, "TaskManager: task not approved/resolved");
        require(address(reputationEngine) != address(0), "TaskManager: reputation engine not set");
        require(!_taskRated[taskId], "TaskManager: task already rated");

        _taskRated[taskId] = true;
        reputationEngine.rateAgent(t.agent, taskId, rating, comment, msg.sender);
    }

    function setReputationEngine(address _reputationEngine) external onlyOwner {
        require(_reputationEngine != address(0), "TaskManager: zero address");
        address oldReputationEngine = address(reputationEngine);
        reputationEngine = IReputationEngine(_reputationEngine);
        emit ReputationEngineUpdated(oldReputationEngine, _reputationEngine);
    }

    function disputeTask(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        require(msg.sender == t.client, "TaskManager: caller is not the client");
        require(t.state == TaskState.Completed, "TaskManager: task is not Completed");

        t.state = TaskState.Disputed;
        t.disputedAt = block.timestamp;

        emit TaskDisputed(taskId, msg.sender);
    }

    function resolveDispute(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        require(t.state == TaskState.Disputed, "TaskManager: task is not Disputed");
        require(
            block.timestamp >= t.disputedAt + DISPUTE_TIMEOUT,
            "TaskManager: dispute timeout not reached"
        );

        t.state = TaskState.Resolved;

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transfer(t.agent, t.payment), "TaskManager: USDC transfer to agent failed");

        emit TaskResolved(taskId, t.agent, t.payment);
    }

    function ownerResolveDispute(uint256 taskId, bool favorAgent) external onlyOwner {
        Task storage t = _getTask(taskId);
        require(t.state == TaskState.Disputed, "TaskManager: task is not Disputed");

        t.state = TaskState.Resolved;

        IERC20 usdc = IERC20(USDC_TOKEN);
        if (favorAgent) {
            require(usdc.transfer(t.agent, t.payment), "TaskManager: USDC transfer to agent failed");
            totalVolume += t.payment;
            totalApprovedTasks += 1;
            emit TaskResolved(taskId, t.agent, t.payment);
        } else {
            require(usdc.transfer(t.client, t.payment), "TaskManager: USDC refund to client failed");
            emit TaskCancelled(taskId, t.client, t.payment);
        }

        emit DisputeResolvedByOwner(taskId, favorAgent);
    }

    function cancelTask(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        require(msg.sender == t.client, "TaskManager: caller is not the client");
        require(t.state == TaskState.Created, "TaskManager: task is not in Created state");

        t.state = TaskState.Cancelled;

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transfer(t.client, t.payment), "TaskManager: USDC refund failed");

        emit TaskCancelled(taskId, msg.sender, t.payment);
    }

    function reclaimTask(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        require(msg.sender == t.client, "TaskManager: caller is not the client");
        require(t.state == TaskState.Created, "TaskManager: task is not in Created state");
        require(
            block.timestamp >= t.createdAt + ACCEPT_TIMEOUT,
            "TaskManager: accept timeout not reached"
        );

        t.state = TaskState.Cancelled;

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transfer(t.client, t.payment), "TaskManager: USDC refund failed");

        emit TaskCancelled(taskId, msg.sender, t.payment);
    }

    function emergencyWithdraw(uint256 taskId) external onlyOwner {
        Task storage t = _getTask(taskId);
        require(
            t.state != TaskState.Approved &&
            t.state != TaskState.Resolved &&
            t.state != TaskState.Cancelled,
            "TaskManager: task already finalized"
        );
        require(
            block.timestamp >= t.createdAt + EMERGENCY_TIMEOUT,
            "TaskManager: task is not old enough"
        );

        t.state = TaskState.Cancelled;

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transfer(owner, t.payment), "TaskManager: USDC emergency transfer failed");

        emit EmergencyWithdraw(taskId, t.payment);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "TaskManager: zero address");
        require(newOwner != owner, "TaskManager: already the owner");
        pendingOwner = newOwner;
        emit OwnershipTransferProposed(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "TaskManager: caller is not the pending owner");
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }

    function getTask(uint256 taskId) external view returns (Task memory) {
        require(taskId < tasks.length, "TaskManager: task does not exist");
        return tasks[taskId];
    }

    function getTaskCount() external view returns (uint256) {
        return tasks.length;
    }

    function getTasksByClient(address client) external view returns (uint256[] memory) {
        return _clientTasks[client];
    }

    function getTasksByAgent(address agent) external view returns (uint256[] memory) {
        return _agentTasks[agent];
    }

    function getMarketStats() external view returns (uint256 totalTasks, uint256 approvedTasks, uint256 volume) {
        totalTasks    = tasks.length;
        approvedTasks = totalApprovedTasks;
        volume        = totalVolume;
    }

    function _getTask(uint256 taskId) internal view returns (Task storage) {
        require(taskId < tasks.length, "TaskManager: task does not exist");
        return tasks[taskId];
    }
}
