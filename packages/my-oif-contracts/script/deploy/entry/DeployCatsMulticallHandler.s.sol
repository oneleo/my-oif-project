// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { CatsMulticallHandler } from "oif-contracts/src/integrations/CatsMulticallHandler.sol";

import { DeployCoreBase } from "../lib/DeployCoreBase.sol";
import { NickCreate2Deploy } from "../lib/NickCreate2Deploy.sol";

contract DeployCatsMulticallHandler is DeployCoreBase {
    function run() external {
        logCommonHeader("DeployCatsMulticallHandler");

        vm.startBroadcast(deployer);
        address deployed = NickCreate2Deploy.deployOrAttach(
            salt,
            type(CatsMulticallHandler).creationCode,
            "CatsMulticallHandler"
        );
        vm.stopBroadcast();

        writeAddressRecord("catsMulticallHandler", deployed);
    }
}
