// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
// TaskManager.sol — Task creation and lifecycle management
// Target: X Layer (Chain ID 196)
// =============================================================================

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IAgentRegistry {
    function isAgentActive(uint256 agentId) external view returns (bool);
    function incrementTasks(uint256 agentId, uint256 earned) external;
}

interface IReputationEngine {
    function rateAgent(uint256 agentId, uint256 taskId, uint8 rating, string calldata comment, address reviewer) external;
}

contract TaskManager {

    /// @notice USDC token on X Layer (6 decimals).
    address public constant USDC_TOKEN = 0x74b7F16337b8972027F6196A17a631aC6dE26d22;

    uint256 public constant DISPUTE_TIMEOUT = 24 hours;
    uint256 public constant ACCEPT_TIMEOUT = 48 hours;
    uint256 public constant AUTO_APPROVE_TIMEOUT = 72 hours;
    uint256 public constant EMERGENCY_TIMEOUT = 30 days;

    enum TaskState { Created, InProgress, Completed, Approved, Disputed, Resolved, Cancelled }

    struct Task {
        address client;
        uint256 agentId;       // references AgentRegistry agent ID
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
    mapping(uint256 => uint256[]) private _agentTasks;  // agentId → taskIds
    mapping(uint256 => bool) private _taskRated;
    uint256 public totalVolume;
    uint256 public totalApprovedTasks;

    event TaskCreated(uint256 indexed taskId, address indexed client, uint256 indexed agentId, uint256 payment);
    event TaskAccepted(uint256 indexed taskId, uint256 indexed agentId);
    event TaskCompleted(uint256 indexed taskId, uint256 indexed agentId, string resultHash);
    event TaskApproved(uint256 indexed taskId, address indexed client, uint256 indexed agentId, uint256 payment);
    event TaskDisputed(uint256 indexed taskId, address indexed client);
    event TaskResolved(uint256 indexed taskId, uint256 indexed agentId, uint256 payment);
    event TaskCancelled(uint256 indexed taskId, address indexed client, uint256 refund);
    event TaskAutoApproved(uint256 indexed taskId, uint256 indexed agentId, uint256 payment);
    event DisputeResolvedByOwner(uint256 indexed taskId, bool favorAgent);
    event EmergencyWithdraw(uint256 indexed taskId, uint256 amount);
    event ReputationEngineUpdated(address indexed oldAddr, address indexed newAddr);
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
        uint256 agentId,
        string calldata description,
        uint256 payment
    ) external returns (uint256 taskId) {
        require(payment > 0, "TaskManager: payment must be > 0");
        require(agentRegistry.isAgentActive(agentId), "TaskManager: agent not registered or inactive");

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transferFrom(msg.sender, address(this), payment), "TaskManager: USDC transfer failed");

        taskId = tasks.length;
        tasks.push(Task({
            client:      msg.sender,
            agentId:     agentId,
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
        _agentTasks[agentId].push(taskId);

        emit TaskCreated(taskId, msg.sender, agentId, payment);
    }

    function acceptTask(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        // Agent owner must call this
        require(t.state == TaskState.Created, "TaskManager: task is not in Created state");

        t.state = TaskState.InProgress;
        t.acceptedAt = block.timestamp;

        emit TaskAccepted(taskId, t.agentId);
    }

    function completeTask(uint256 taskId, string calldata resultHash) external {
        Task storage t = _getTask(taskId);
        require(t.state == TaskState.InProgress, "TaskManager: task is not InProgress");

        t.resultHash = resultHash;
        t.state = TaskState.Completed;
        t.completedAt = block.timestamp;

        emit TaskCompleted(taskId, t.agentId, resultHash);
    }

    function approveTask(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        require(msg.sender == t.client, "TaskManager: caller is not the client");
        require(t.state == TaskState.Completed, "TaskManager: task is not Completed");

        t.state = TaskState.Approved;

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transfer(msg.sender, t.payment), "TaskManager: USDC transfer failed");

        agentRegistry.incrementTasks(t.agentId, t.payment);
        totalVolume += t.payment;
        totalApprovedTasks += 1;

        emit TaskApproved(taskId, msg.sender, t.agentId, t.payment);
    }

    function autoApproveTask(uint256 taskId) external {
        Task storage t = _getTask(taskId);
        require(t.state == TaskState.Completed, "TaskManager: task is not Completed");
        require(block.timestamp >= t.completedAt + AUTO_APPROVE_TIMEOUT, "TaskManager: auto-approve timeout not reached");

        t.state = TaskState.Approved;

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transfer(t.client, t.payment), "TaskManager: USDC transfer failed");

        agentRegistry.incrementTasks(t.agentId, t.payment);
        totalVolume += t.payment;
        totalApprovedTasks += 1;

        emit TaskAutoApproved(taskId, t.agentId, t.payment);
    }

    function rateAgent(uint256 taskId, uint8 rating, string calldata comment) external {
        Task storage t = _getTask(taskId);
        require(msg.sender == t.client, "TaskManager: caller is not the client");
        require(t.state == TaskState.Approved || t.state == TaskState.Resolved, "TaskManager: task not approved/resolved");
        require(address(reputationEngine) != address(0), "TaskManager: reputation engine not set");
        require(!_taskRated[taskId], "TaskManager: task already rated");

        _taskRated[taskId] = true;
        reputationEngine.rateAgent(t.agentId, taskId, rating, comment, msg.sender);
    }

    function setReputationEngine(address _reputationEngine) external onlyOwner {
        require(_reputationEngine != address(0), "TaskManager: zero address");
        address old = address(reputationEngine);
        reputationEngine = IReputationEngine(_reputationEngine);
        emit ReputationEngineUpdated(old, _reputationEngine);
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
        require(block.timestamp >= t.disputedAt + DISPUTE_TIMEOUT, "TaskManager: dispute timeout not reached");

        t.state = TaskState.Resolved;

        IERC20 usdc = IERC20(USDC_TOKEN);
        require(usdc.transfer(t.client, t.payment), "TaskManager: USDC transfer failed");
        emit TaskResolved(taskId, t.agentId, t.payment);
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

    function emergencyWithdraw(uint256 taskId) external onlyOwner {
        Task storage t = _getTask(taskId);
        require(
            t.state != TaskState.Approved && t.state != TaskState.Resolved && t.state != TaskState.Cancelled,
            "TaskManager: task already finalized"
        );
        require(block.timestamp >= t.createdAt + EMERGENCY_TIMEOUT, "TaskManager: task is not old enough");

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
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    // ── View Functions ───────────────────────────────────────────────────────

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

    function getTasksByAgent(uint256 agentId) external view returns (uint256[] memory) {
        return _agentTasks[agentId];
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
