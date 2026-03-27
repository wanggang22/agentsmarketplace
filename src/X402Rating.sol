// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title X402Rating — On-chain ratings for x402 API calls
/// @notice Each rating must provide an x402 settlement txHash as proof-of-usage.
///         Same txHash cannot be used twice, preventing spam/fake ratings.

contract X402Rating {
    struct Rating {
        address rater;
        uint256 agentId;
        uint8 score;          // 1-5 stars
        string comment;
        bytes32 txHash;       // x402 settlement tx as proof-of-usage
        uint256 timestamp;
    }

    struct AgentStats {
        uint256 totalRatings;
        uint256 totalScore;
    }

    mapping(uint256 => Rating[]) private _agentRatings;   // agentId → ratings
    mapping(bytes32 => bool) public txHashUsed;            // prevent double-rating
    mapping(uint256 => AgentStats) private _stats;         // agentId → aggregate stats

    event AgentRated(
        uint256 indexed agentId,
        address indexed rater,
        uint8 score,
        bytes32 txHash,
        uint256 timestamp
    );

    /// @notice Submit a rating for an agent after using their x402 service
    /// @param agentId The agent's registry ID
    /// @param score Rating 1-5 (1=terrible, 5=excellent)
    /// @param comment Optional text review
    /// @param txHash The x402 settlement transaction hash (proof you actually paid)
    function rate(
        uint256 agentId,
        uint8 score,
        string calldata comment,
        bytes32 txHash
    ) external {
        require(score >= 1 && score <= 5, "X402Rating: score must be 1-5");
        require(txHash != bytes32(0), "X402Rating: txHash required");
        require(!txHashUsed[txHash], "X402Rating: already rated for this transaction");

        txHashUsed[txHash] = true;

        _agentRatings[agentId].push(Rating({
            rater: msg.sender,
            agentId: agentId,
            score: score,
            comment: comment,
            txHash: txHash,
            timestamp: block.timestamp
        }));

        AgentStats storage stats = _stats[agentId];
        stats.totalRatings += 1;
        stats.totalScore += score;

        emit AgentRated(agentId, msg.sender, score, txHash, block.timestamp);
    }

    /// @notice Get aggregate stats for an agent
    function getAgentStats(uint256 agentId)
        external view
        returns (uint256 totalRatings, uint256 avgScoreX100)
    {
        AgentStats storage stats = _stats[agentId];
        totalRatings = stats.totalRatings;
        avgScoreX100 = stats.totalRatings > 0
            ? (stats.totalScore * 100) / stats.totalRatings
            : 0;
    }

    /// @notice Get paginated ratings for an agent
    function getRatings(uint256 agentId, uint256 offset, uint256 limit)
        external view
        returns (Rating[] memory)
    {
        Rating[] storage all = _agentRatings[agentId];
        uint256 total = all.length;
        if (offset >= total) return new Rating[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;

        Rating[] memory result = new Rating[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = all[offset + i];
        }
        return result;
    }

    /// @notice Get total number of ratings for an agent
    function getRatingCount(uint256 agentId) external view returns (uint256) {
        return _agentRatings[agentId].length;
    }
}
