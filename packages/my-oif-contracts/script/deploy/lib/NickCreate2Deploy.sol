// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Create2 } from "openzeppelin/utils/Create2.sol";
import { console2 } from "forge-std/console2.sol";

library NickCreate2Deploy {
    address internal constant ONCHAIN_CREATE2_FACTORY =
        0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function computeAddress(
        bytes32 salt,
        bytes memory initCode
    ) internal pure returns (address) {
        return
            Create2.computeAddress(
                salt,
                keccak256(initCode),
                ONCHAIN_CREATE2_FACTORY
            );
    }

    function deploy(
        bytes32 salt,
        bytes memory initCode
    ) internal returns (address deployed) {
        deployed = computeAddress(salt, initCode);

        bytes memory deployCalldata = abi.encodePacked(salt, initCode);
        (bool success, ) = ONCHAIN_CREATE2_FACTORY.call(deployCalldata);
        require(success && deployed.code.length > 0, "CREATE2 deploy failed");
    }

    function deployOrAttach(
        bytes32 salt,
        bytes memory initCode,
        string memory label
    ) internal returns (address addr) {
        addr = computeAddress(salt, initCode);
        if (addr.code.length > 0) {
            console2.log(string.concat(label, " already deployed at"), addr);
            return addr;
        }

        addr = deploy(salt, initCode);
        console2.log(string.concat("Deployed ", label), addr);
    }
}
