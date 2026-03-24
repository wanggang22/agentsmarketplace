// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AgentRegistry
/// @notice AI Agent service marketplace registry for X Layer (Chain ID 196).
///         pricePerTask is denominated in USDC with 6 decimals.
/// @dev    This contract only tracks agent metadata and task accounting.
contract AgentRegistry {

    // ──────────────────────────────────────────────
    //  Types
    // ──────────────────────────────────────────────

    /// @notice Full on-chain profile for a registered AI agent.
    struct Agent {
        string   name;           // Human-readable agent name
        string   description;    // Short description of what the agent does
        string   endpoint;       // URL or URI clients use to reach the agent
        uint256  pricePerTask;   // Cost per task in USDC (6 decimals, e.g. 1_000_000 = 1 USDC)
        string[] skillTags;      // Searchable skill/category tags
        bool     active;         // Whether the agent is currently accepting tasks
        uint256  registeredAt;   // Block timestamp of initial registration
        uint256  totalTasks;     // Lifetime tasks completed
        uint256  totalEarned;    // Lifetime USDC earned (6 decimals)
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    /// @notice Contract deployer / admin.
    address public owner;

    /// @notice Pending owner for two-step ownership transfer.
    address public pendingOwner;

    /// @notice Authorised TaskManager contract that may call `incrementTasks`.
    address public taskManager;

    /// @dev    agent address → Agent struct
    mapping(address => Agent) private _agents;

    /// @dev    Ordered list of every address that has ever registered.
    address[] private _agentAddresses;

    /// @dev    Quick lookup to avoid duplicate entries in _agentAddresses.
    mapping(address => bool) private _registered;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    event AgentRegistered(address indexed agent, string name);
    event AgentUpdated(address indexed agent);
    event AgentDeactivated(address indexed agent);
    event AgentActivated(address indexed agent);
    event AgentUnregistered(address indexed agent);
    event TaskManagerUpdated(address indexed oldAddr, address indexed newAddr);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "AgentRegistry: caller is not the owner");
        _;
    }

    modifier onlyTaskManager() {
        require(
            msg.sender == taskManager && taskManager != address(0),
            "AgentRegistry: caller is not the task manager"
        );
        _;
    }

    modifier onlyRegistered() {
        require(_registered[msg.sender], "AgentRegistry: agent not registered");
        _;
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    /// @notice Deploys the registry and sets the caller as owner.
    constructor() {
        owner = msg.sender;
    }

    // ──────────────────────────────────────────────
    //  Agent Registration
    // ──────────────────────────────────────────────

    function registerAgent(
        string calldata _name,
        string calldata _description,
        string calldata _endpoint,
        uint256 _pricePerTask,
        string[] calldata _skillTags
    ) external {
        require(!_registered[msg.sender], "AgentRegistry: already registered");
        require(bytes(_name).length > 0, "AgentRegistry: name is required");
        require(bytes(_endpoint).length > 0, "AgentRegistry: endpoint is required");
        require(_skillTags.length <= 20, "AgentRegistry: too many tags");

        Agent storage a = _agents[msg.sender];
        a.name         = _name;
        a.description  = _description;
        a.endpoint     = _endpoint;
        a.pricePerTask = _pricePerTask;
        a.active       = true;
        a.registeredAt = block.timestamp;

        for (uint256 i = 0; i < _skillTags.length; i++) {
            a.skillTags.push(_skillTags[i]);
        }

        _agentAddresses.push(msg.sender);
        _registered[msg.sender] = true;

        emit AgentRegistered(msg.sender, _name);
    }

    // ──────────────────────────────────────────────
    //  Agent Updates
    // ──────────────────────────────────────────────

    function updateAgent(
        string calldata _name,
        string calldata _description,
        string calldata _endpoint,
        uint256 _pricePerTask,
        string[] calldata _skillTags
    ) external onlyRegistered {
        require(bytes(_name).length > 0, "AgentRegistry: name is required");
        require(bytes(_endpoint).length > 0, "AgentRegistry: endpoint is required");
        require(_skillTags.length <= 20, "AgentRegistry: too many tags");

        Agent storage a = _agents[msg.sender];
        a.name         = _name;
        a.description  = _description;
        a.endpoint     = _endpoint;
        a.pricePerTask = _pricePerTask;

        delete a.skillTags;
        for (uint256 i = 0; i < _skillTags.length; i++) {
            a.skillTags.push(_skillTags[i]);
        }

        emit AgentUpdated(msg.sender);
    }

    // ──────────────────────────────────────────────
    //  Unregister
    // ──────────────────────────────────────────────

    function unregisterAgent() external onlyRegistered {
        Agent storage a = _agents[msg.sender];
        delete a.name;
        delete a.description;
        delete a.endpoint;
        a.pricePerTask = 0;
        delete a.skillTags;
        a.active = false;
        a.registeredAt = 0;
        a.totalTasks = 0;
        a.totalEarned = 0;

        _registered[msg.sender] = false;

        emit AgentUnregistered(msg.sender);
    }

    // ──────────────────────────────────────────────
    //  Activation / Deactivation
    // ──────────────────────────────────────────────

    function deactivateAgent() external onlyRegistered {
        require(_agents[msg.sender].active, "AgentRegistry: already inactive");
        _agents[msg.sender].active = false;
        emit AgentDeactivated(msg.sender);
    }

    function activateAgent() external onlyRegistered {
        require(!_agents[msg.sender].active, "AgentRegistry: already active");
        _agents[msg.sender].active = true;
        emit AgentActivated(msg.sender);
    }

    // ──────────────────────────────────────────────
    //  Task Accounting
    // ──────────────────────────────────────────────

    function incrementTasks(address _agent, uint256 _earned) external onlyTaskManager {
        require(_registered[_agent], "AgentRegistry: agent not registered");

        _agents[_agent].totalTasks  += 1;
        _agents[_agent].totalEarned += _earned;
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    function setTaskManager(address _taskManager) external onlyOwner {
        require(_taskManager != address(0), "AgentRegistry: zero address");
        address oldTaskManager = taskManager;
        taskManager = _taskManager;
        emit TaskManagerUpdated(oldTaskManager, _taskManager);
    }

    // ──────────────────────────────────────────────
    //  Ownership Transfer (Two-Step)
    // ──────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "AgentRegistry: zero address");
        require(newOwner != owner, "AgentRegistry: already the owner");
        pendingOwner = newOwner;
        emit OwnershipTransferProposed(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "AgentRegistry: caller is not the pending owner");
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }

    // ──────────────────────────────────────────────
    //  View / Query Functions
    // ──────────────────────────────────────────────

    function getAgent(address _agent) external view returns (Agent memory) {
        return _agents[_agent];
    }

    function getAgentsPaginated(
        uint256 _offset,
        uint256 _limit
    ) external view returns (Agent[] memory agents, address[] memory addresses) {
        uint256 total = _agentAddresses.length;

        if (_offset >= total) {
            return (new Agent[](0), new address[](0));
        }

        uint256 remaining = total - _offset;
        uint256 count = _limit < remaining ? _limit : remaining;

        agents    = new Agent[](count);
        addresses = new address[](count);

        for (uint256 i = 0; i < count; i++) {
            address addr = _agentAddresses[_offset + i];
            agents[i]    = _agents[addr];
            addresses[i] = addr;
        }
    }

    function getAgentCount() external view returns (uint256) {
        return _agentAddresses.length;
    }

    function isRegistered(address _agent) external view returns (bool) {
        return _registered[_agent];
    }

    function isAgentActive(address _agent) external view returns (bool) {
        return _registered[_agent] && _agents[_agent].active;
    }
}
