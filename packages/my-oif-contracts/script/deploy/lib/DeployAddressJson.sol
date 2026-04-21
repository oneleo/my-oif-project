// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Vm } from "forge-std/Vm.sol";

library DeployAddressJson {
    string internal constant DEFAULT_PATH = "./script/deploy/addresses.json";
    string internal constant DEFAULT_REFERENCE_PATH =
        "./script/deploy/addresses.json";

    function targetPath(Vm vm_) internal view returns (string memory) {
        return vm_.envOr("DEPLOY_ADDRESSES_PATH", DEFAULT_PATH);
    }

    function referencePath(Vm vm_) internal view returns (string memory) {
        return
            vm_.envOr(
                "DEPLOY_REFERENCE_ADDRESSES_PATH",
                DEFAULT_REFERENCE_PATH
            );
    }

    function ensureTargetFile(Vm vm_) internal {
        string memory path = targetPath(vm_);
        if (!vm_.exists(path)) {
            vm_.writeJson("{}", path);
        }
    }

    function syncChainLabel(
        Vm vm_,
        string memory chainKey,
        string memory chainLabel
    ) internal {
        ensureTargetFile(vm_);
        vm_.writeJson(
            string.concat('"', chainLabel, '"'),
            targetPath(vm_),
            string.concat(".", chainKey, ".chainLabel")
        );
    }

    function writeAddr(
        Vm vm_,
        string memory chainKey,
        string memory field,
        address addr
    ) internal {
        ensureTargetFile(vm_);
        vm_.writeJson(
            vm_.toString(addr),
            targetPath(vm_),
            string.concat(".", chainKey, ".", field)
        );
    }

    function readAddr(
        Vm vm_,
        string memory path,
        string memory chainKey,
        string memory field
    ) internal view returns (address) {
        if (!vm_.exists(path)) return address(0);

        string memory json = vm_.readFile(path);
        string memory key = string.concat(".", chainKey, ".", field);
        if (!vm_.keyExistsJson(json, key)) return address(0);

        return vm_.parseJsonAddress(json, key);
    }
}
