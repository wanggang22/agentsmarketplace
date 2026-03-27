// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/X402Rating.sol";

contract DeployX402Rating is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(deployerPk);

        X402Rating rating = new X402Rating();
        console.log("X402Rating deployed at:", address(rating));

        vm.stopBroadcast();
    }
}
