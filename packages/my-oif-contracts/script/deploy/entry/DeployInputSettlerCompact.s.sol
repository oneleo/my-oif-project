// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { InputSettlerCompact } from "oif-contracts/src/input/compact/InputSettlerCompact.sol";

import { DeployCoreBase } from "../lib/DeployCoreBase.sol";
import { NickCreate2Deploy } from "../lib/NickCreate2Deploy.sol";

contract DeployInputSettlerCompact is DeployCoreBase {
    string internal constant CONFIG_PATH =
        "./script/deploy/config/inputSettlerCompact.json";

    function run() external {
        logCommonHeader("DeployInputSettlerCompact");

        requireChainConfig(CONFIG_PATH);
        address compact = readRequiredAddress(CONFIG_PATH, "compact");
        require(compact != address(0), "compact is zero");

        bytes memory initCode = abi.encodePacked(
            type(InputSettlerCompact).creationCode,
            abi.encode(compact)
        );

        vm.startBroadcast(deployer);
        address deployed = NickCreate2Deploy.deployOrAttach(
            salt,
            initCode,
            "InputSettlerCompact"
        );
        vm.stopBroadcast();

        writeAddressRecord("inputSettlerCompact", deployed);
    }
}
