// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AgentRegistry
/// @notice AI Agent service marketplace registry for X Layer (Chain ID 196).
///         One address can register multiple agents. Each agent has a unique numeric ID.
contract AgentRegistry {

    struct Agent {
        address owner;
        string   name;
        string   description;
        string   endpoint;
        uint256  pricePerTask;
        string[] skillTags;
        bool     active;
        uint256  registeredAt;
        uint256  totalTasks;
        uint256  totalEarned;
    }

    address public owner;
    address public pendingOwner;
    address public taskManager;

    /// @dev All agents, indexed by agentId (0-based).
    Agent[] private _agents;

    /// @dev owner address → array of agentIds they own.
    mapping(address => uint256[]) private _ownerAgents;

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string name);
    event AgentUpdated(uint256 indexed agentId);
    event AgentDeactivated(uint256 indexed agentId);
    event AgentActivated(uint256 indexed agentId);
    event AgentUnregistered(uint256 indexed agentId);
    event TaskManagerUpdated(address indexed oldAddr, address indexed newAddr);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

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

    modifier onlyAgentOwner(uint256 agentId) {
        require(agentId < _agents.length, "AgentRegistry: agent does not exist");
        require(_agents[agentId].owner == msg.sender, "AgentRegistry: not the agent owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ──────────────────────────────────────────────
    //  Registration (one address can register many)
    // ──────────────────────────────────────────────

    function registerAgent(
        string calldata _name,
        string calldata _description,
        string calldata _endpoint,
        uint256 _pricePerTask,
        string[] calldata _skillTags
    ) external returns (uint256 agentId) {
        require(bytes(_name).length > 0, "AgentRegistry: name is required");
        require(bytes(_endpoint).length > 0, "AgentRegistry: endpoint is required");
        require(_skillTags.length <= 20, "AgentRegistry: too many tags");

        agentId = _agents.length;
        _agents.push();

        Agent storage a = _agents[agentId];
        a.owner        = msg.sender;
        a.name         = _name;
        a.description  = _description;
        a.endpoint     = _endpoint;
        a.pricePerTask = _pricePerTask;
        a.active       = true;
        a.registeredAt = block.timestamp;

        for (uint256 i = 0; i < _skillTags.length; i++) {
            a.skillTags.push(_skillTags[i]);
        }

        _ownerAgents[msg.sender].push(agentId);

        emit AgentRegistered(agentId, msg.sender, _name);
    }

    // ──────────────────────────────────────────────
    //  Updates
    // ──────────────────────────────────────────────

    function updateAgent(
        uint256 agentId,
        string calldata _name,
        string calldata _description,
        string calldata _endpoint,
        uint256 _pricePerTask,
        string[] calldata _skillTags
    ) external onlyAgentOwner(agentId) {
        require(bytes(_name).length > 0, "AgentRegistry: name is required");
        require(bytes(_endpoint).length > 0, "AgentRegistry: endpoint is required");
        require(_skillTags.length <= 20, "AgentRegistry: too many tags");

        Agent storage a = _agents[agentId];
        a.name         = _name;
        a.description  = _description;
        a.endpoint     = _endpoint;
        a.pricePerTask = _pricePerTask;

        delete a.skillTags;
        for (uint256 i = 0; i < _skillTags.length; i++) {
            a.skillTags.push(_skillTags[i]);
        }

        emit AgentUpdated(agentId);
    }

    // ──────────────────────────────────────────────
    //  Activation / Deactivation
    // ──────────────────────────────────────────────

    function deactivateAgent(uint256 agentId) external onlyAgentOwner(agentId) {
        require(_agents[agentId].active, "AgentRegistry: already inactive");
        _agents[agentId].active = false;
        emit AgentDeactivated(agentId);
    }

    function activateAgent(uint256 agentId) external onlyAgentOwner(agentId) {
        require(!_agents[agentId].active, "AgentRegistry: already active");
        _agents[agentId].active = true;
        emit AgentActivated(agentId);
    }

    // ──────────────────────────────────────────────
    //  Task Accounting
    // ──────────────────────────────────────────────

    function incrementTasks(uint256 agentId, uint256 _earned) external onlyTaskManager {
        require(agentId < _agents.length, "AgentRegistry: agent does not exist");

        _agents[agentId].totalTasks  += 1;
        _agents[agentId].totalEarned += _earned;
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

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        require(agentId < _agents.length, "AgentRegistry: agent does not exist");
        return _agents[agentId];
    }

    function getAgentCount() external view returns (uint256) {
        return _agents.length;
    }

    function getAgentsByOwner(address _owner) external view returns (uint256[] memory) {
        return _ownerAgents[_owner];
    }

    function getAgentsPaginated(
        uint256 _offset,
        uint256 _limit
    ) external view returns (Agent[] memory agents, uint256[] memory ids) {
        uint256 total = _agents.length;

        if (_offset >= total) {
            return (new Agent[](0), new uint256[](0));
        }

        uint256 remaining = total - _offset;
        uint256 count = _limit < remaining ? _limit : remaining;

        agents = new Agent[](count);
        ids    = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            agents[i] = _agents[_offset + i];
            ids[i]    = _offset + i;
        }
    }

    /// @notice Check if a specific agent ID is registered and active.
    function isAgentActive(uint256 agentId) external view returns (bool) {
        if (agentId >= _agents.length) return false;
        return _agents[agentId].active;
    }
}
