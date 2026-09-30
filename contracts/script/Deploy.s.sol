// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {CaseLedger} from "../src/CaseLedger.sol";

contract Deploy is Script {
    function run() external returns (CaseLedger ledger) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(key);
        ledger = new CaseLedger();
        vm.stopBroadcast();
        string memory object = "deployment";
        vm.serializeUint(object, "chainId", block.chainid);
        string memory json = vm.serializeAddress(object, "address", address(ledger));
        vm.writeJson(json, string.concat("../deployments/", vm.toString(block.chainid), ".json"));
    }
}
