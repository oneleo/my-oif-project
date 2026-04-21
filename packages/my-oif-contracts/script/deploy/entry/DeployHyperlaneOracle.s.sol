// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { HyperlaneOracle } from "oif-contracts/src/integrations/oracles/hyperlane/HyperlaneOracle.sol";

import { DeployCoreBase } from "../lib/DeployCoreBase.sol";
import { NickCreate2Deploy } from "../lib/NickCreate2Deploy.sol";

contract DeployHyperlaneOracle is DeployCoreBase {
    string internal constant CONFIG_PATH =
        "./script/deploy/config/hyperlaneOracle.json";

    function run() external {
        logCommonHeader("DeployHyperlaneOracle");

        requireChainConfig(CONFIG_PATH);
        address mailbox = readRequiredAddress(CONFIG_PATH, "mailbox");
        address customHook = readOptionalAddress(
            CONFIG_PATH,
            "customHook",
            address(0)
        );
        address ism = readOptionalAddress(CONFIG_PATH, "ism", address(0));
        require(mailbox != address(0), "mailbox is zero");

        bytes memory initCode = abi.encodePacked(
            type(HyperlaneOracle).creationCode,
            abi.encode(mailbox, customHook, ism)
        );

        vm.startBroadcast(deployer);
        address deployed = NickCreate2Deploy.deployOrAttach(
            salt,
            initCode,
            "HyperlaneOracle"
        );
        vm.stopBroadcast();

        writeAddressRecord("hyperlaneOracle", deployed);
    }
}
