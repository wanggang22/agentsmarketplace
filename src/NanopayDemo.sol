// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title NanopayDemo
/// @notice Demo contract for recording nanopayment metadata on-chain.
///         WARNING: Recorded payments are NOT validated against actual token transfers.
contract NanopayDemo {
    struct NanopayRecord {
        address payer;
        address agent;
        uint256 amount;
        string taskType;
        uint256 timestamp;
    }

    uint256 public constant MAX_RECORDS = 1000;

    NanopayRecord[] private _payments;
    mapping(address => uint256[]) private _agentPaymentIndices;

    event NanopaymentRecorded(address indexed payer, address indexed agent, uint256 amount, string taskType);

    function recordPayment(
        address agent,
        uint256 amount,
        string calldata taskType
    ) external {
        require(bytes(taskType).length <= 100, "NanopayDemo: taskType too long");
        require(_payments.length < MAX_RECORDS, "NanopayDemo: max records reached");

        uint256 index = _payments.length;

        _payments.push(NanopayRecord({
            payer: msg.sender,
            agent: agent,
            amount: amount,
            taskType: taskType,
            timestamp: block.timestamp
        }));

        _agentPaymentIndices[agent].push(index);

        emit NanopaymentRecorded(msg.sender, agent, amount, taskType);
    }

    function getPayments(uint256 offset, uint256 limit)
        external view returns (NanopayRecord[] memory)
    {
        uint256 total = _payments.length;
        if (offset >= total) return new NanopayRecord[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;

        NanopayRecord[] memory result = new NanopayRecord[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = _payments[offset + i];
        }
        return result;
    }

    function getPaymentCount() external view returns (uint256) {
        return _payments.length;
    }

    function getPaymentsByAgent(address agent) external view returns (uint256[] memory) {
        return _agentPaymentIndices[agent];
    }
}
