// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WritLib} from "../../src/WritLib.sol";

/// @dev External surface for `WritLib` so its cost can be measured across a real call boundary.
contract WritLibHarness {
    function recoverSigner(bytes32 reqHash, bytes32 respHash, bytes memory signature) external pure returns (address) {
        return WritLib.recoverSigner(reqHash, respHash, signature);
    }

    function recoverRoutingProofSigner(
        bytes32 reqHash,
        bytes32 respHash,
        string memory providerType,
        string memory providerIdentity,
        bytes32 tlsFingerprint,
        bytes memory signature
    ) external pure returns (address) {
        return WritLib.recoverRoutingProofSigner(
            reqHash, respHash, providerType, providerIdentity, tlsFingerprint, signature
        );
    }
}
