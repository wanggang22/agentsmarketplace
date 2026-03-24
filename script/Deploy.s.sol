// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AgentRegistry.sol";
import "../src/TaskManager.sol";
import "../src/ReputationEngine.sol";
import "../src/NanopayDemo.sol";

/// @notice Deploy all AgentsMarketplace contracts to X Layer and wire them together.
///
/// Usage:
///   DEPLOYER_PK=0x... forge script script/Deploy.s.sol \
///     --rpc-url https://rpc.xlayer.tech --broadcast --legacy
contract Deploy is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(deployerPk);

        // 1. Deploy AgentRegistry
        AgentRegistry registry = new AgentRegistry();
        console.log("AgentRegistry:", address(registry));

        // 2. Deploy TaskManager (needs registry address)
        TaskManager taskMgr = new TaskManager(address(registry));
        console.log("TaskManager:", address(taskMgr));

        // 3. Deploy ReputationEngine
        ReputationEngine reputation = new ReputationEngine();
        console.log("ReputationEngine:", address(reputation));

        // 4. Deploy NanopayDemo
        NanopayDemo nanopay = new NanopayDemo();
        console.log("NanopayDemo:", address(nanopay));

        // 5. Wire contracts together
        registry.setTaskManager(address(taskMgr));
        taskMgr.setReputationEngine(address(reputation));
        reputation.setTaskManager(address(taskMgr));

        console.log("");
        console.log("=== Deployment complete ===");
        console.log("  AgentRegistry:   ", address(registry));
        console.log("  TaskManager:     ", address(taskMgr));
        console.log("  ReputationEngine:", address(reputation));
        console.log("  NanopayDemo:     ", address(nanopay));

        vm.stopBroadcast();
    }
}
