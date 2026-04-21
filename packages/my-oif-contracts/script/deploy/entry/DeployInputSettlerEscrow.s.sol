// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { InputSettlerEscrow } from "oif-contracts/src/input/escrow/InputSettlerEscrow.sol";

import { DeployCoreBase } from "../lib/DeployCoreBase.sol";
import { NickCreate2Deploy } from "../lib/NickCreate2Deploy.sol";

contract DeployInputSettlerEscrow is DeployCoreBase {
    function run() external {
        logCommonHeader("DeployInputSettlerEscrow");

        vm.startBroadcast(deployer);
        address deployed = NickCreate2Deploy.deployOrAttach(
            salt,
            type(InputSettlerEscrow).creationCode,
            "InputSettlerEscrow"
        );
        vm.stopBroadcast();

        writeAddressRecord("inputSettlerEscrow", deployed);
    }
}
