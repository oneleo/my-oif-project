// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";

abstract contract DeployScriptJsonHelpers is Script {
    function chainKey() internal view returns (string memory) {
        return vm.toString(block.chainid);
    }

    function chainLabelForAddressJson()
        internal
        view
        returns (string memory)
    {
        string memory key = string.concat(".", vm.toString(block.chainid));
        string memory path = "./script/deploy/config/chainLabels.json";

        if (!vm.exists(path)) {
            return string.concat("chain-", vm.toString(block.chainid));
        }

        string memory json = vm.readFile(path);
        if (vm.keyExistsJson(json, key)) {
            string memory objectKey = string.concat(key, ".chainLabel");
            if (vm.keyExistsJson(json, objectKey)) {
                return vm.parseJsonString(json, objectKey);
            }
            return vm.parseJsonString(json, key);
        }

        return string.concat("chain-", vm.toString(block.chainid));
    }
}
