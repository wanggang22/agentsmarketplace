// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ReputationEngine {
    address public owner;
    address public pendingOwner;
    address public taskManager;

    struct Review {
        uint256 taskId;
        address reviewer;
        uint8 rating;
        string comment;
        uint256 timestamp;
    }

    struct Reputation {
        uint256 totalRatings;
        uint256 totalScore;
        uint256 totalTasks;
    }

    mapping(uint256 => Reputation) private _reputations;  // agentId → reputation
    mapping(uint256 => Review[]) private _reviews;         // agentId → reviews

    event AgentRated(uint256 indexed agentId, address indexed reviewer, uint256 taskId, uint8 rating);
    event TaskManagerUpdated(address indexed oldAddr, address indexed newAddr);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "ReputationEngine: caller is not the owner");
        _;
    }

    modifier onlyTaskManager() {
        require(msg.sender == taskManager, "ReputationEngine: caller is not the TaskManager");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setTaskManager(address _taskManager) external onlyOwner {
        require(_taskManager != address(0), "ReputationEngine: zero address");
        address oldTaskManager = taskManager;
        taskManager = _taskManager;
        emit TaskManagerUpdated(oldTaskManager, _taskManager);
    }

    function rateAgent(
        uint256 agentId,
        uint256 taskId,
        uint8 rating,
        string calldata comment,
        address reviewer
    ) external onlyTaskManager {
        require(reviewer != address(0), "ReputationEngine: zero address reviewer");
        require(rating >= 1 && rating <= 5, "ReputationEngine: rating must be 1-5");

        _reviews[agentId].push(Review({
            taskId: taskId,
            reviewer: reviewer,
            rating: rating,
            comment: comment,
            timestamp: block.timestamp
        }));

        Reputation storage rep = _reputations[agentId];
        rep.totalRatings += 1;
        rep.totalScore += rating;
        rep.totalTasks += 1;

        emit AgentRated(agentId, reviewer, taskId, rating);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ReputationEngine: zero address");
        require(newOwner != owner, "ReputationEngine: already the owner");
        pendingOwner = newOwner;
        emit OwnershipTransferProposed(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "ReputationEngine: caller is not the pending owner");
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }

    function getReputation(uint256 agentId)
        external view
        returns (uint256 totalTasks, uint256 avgRatingX100, uint256 totalRatings)
    {
        Reputation storage rep = _reputations[agentId];
        totalTasks = rep.totalTasks;
        totalRatings = rep.totalRatings;
        avgRatingX100 = rep.totalRatings > 0 ? (rep.totalScore * 100) / rep.totalRatings : 0;
    }

    function getReviews(uint256 agentId, uint256 offset, uint256 limit)
        external view returns (Review[] memory)
    {
        Review[] storage allReviews = _reviews[agentId];
        uint256 total = allReviews.length;

        if (offset >= total) return new Review[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;

        Review[] memory result = new Review[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = allReviews[offset + i];
        }
        return result;
    }

    function getReviewCount(uint256 agentId) external view returns (uint256) {
        return _reviews[agentId].length;
    }
}
