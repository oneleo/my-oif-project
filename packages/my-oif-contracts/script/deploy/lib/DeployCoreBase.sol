// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { console2 } from "forge-std/console2.sol";

import { DeployAddressJson } from "./DeployAddressJson.sol";
import { DeployScriptJsonHelpers } from "./DeployScriptJsonHelpers.sol";

abstract contract DeployCoreBase is DeployScriptJsonHelpers {
    uint256 internal deployerKey = vm.envUint("PRIVATE_KEY");
    address internal deployer = vm.rememberKey(deployerKey);
    bytes32 internal salt = vm.envBytes32("SALT");

    function writeAddressRecord(
        string memory field,
        address deployed
    ) internal {
        string memory currentChainKey = chainKey();

        DeployAddressJson.syncChainLabel(
            vm,
            currentChainKey,
            chainLabelForAddressJson()
        );
        DeployAddressJson.writeAddr(vm, currentChainKey, field, deployed);
    }

    function logCommonHeader(string memory label) internal view {
        console2.log("==============================================");
        console2.log(label);
        console2.log("chainId:", block.chainid);
        console2.log("deployer:", deployer);
        console2.logBytes32(salt);
        console2.log("==============================================");
    }

    function readRequiredAddress(
        string memory path,
        string memory field
    ) internal view returns (address value) {
        string memory json = vm.readFile(path);
        string memory key = string.concat(".", chainKey(), ".", field);
        require(vm.keyExistsJson(json, key), string.concat("missing ", field));
        value = vm.parseJsonAddress(json, key);
    }

    function readOptionalAddress(
        string memory path,
        string memory field,
        address defaultValue
    ) internal view returns (address value) {
        string memory json = vm.readFile(path);
        string memory key = string.concat(".", chainKey(), ".", field);
        if (!vm.keyExistsJson(json, key)) {
            return defaultValue;
        }
        value = vm.parseJsonAddress(json, key);
    }

    function requireChainConfig(
        string memory path
    ) internal view returns (string memory json) {
        json = vm.readFile(path);
        require(
            vm.keyExistsJson(json, string.concat(".", chainKey())),
            "missing chain config"
        );
    }
}
