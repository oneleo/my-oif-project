// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { OutputSettlerSimple } from "oif-contracts/src/output/simple/OutputSettlerSimple.sol";

import { DeployCoreBase } from "../lib/DeployCoreBase.sol";
import { NickCreate2Deploy } from "../lib/NickCreate2Deploy.sol";

contract DeployOutputSettlerSimple is DeployCoreBase {
    function run() external {
        logCommonHeader("DeployOutputSettlerSimple");

        vm.startBroadcast(deployer);
        address deployed = NickCreate2Deploy.deployOrAttach(
            salt,
            type(OutputSettlerSimple).creationCode,
            "OutputSettlerSimple"
        );
        vm.stopBroadcast();

        writeAddressRecord("outputSettlerSimple", deployed);
    }
}
