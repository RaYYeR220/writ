// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyGate} from "../../src/PolicyGate.sol";
import {WritRegistry} from "../../src/WritRegistry.sol";

/// @dev Exposes `PolicyGate`'s internals so the base contract can be tested on its own.
contract PolicyGateHarness is PolicyGate {
    constructor(WritRegistry r) PolicyGate(r) {}

    function setPolicy(uint256 policyId, Policy memory p) external {
        _setPolicy(policyId, p);
    }

    function consume(
        uint256 policyId,
        bytes memory params,
        bytes memory rawResponse,
        address provider,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) external returns (bytes32 id, bool approved, uint8 risk) {
        return _consume(policyId, params, rawResponse, provider, signature, transcriptRoot);
    }

    function consumeRoutingProof(
        uint256 policyId,
        bytes memory params,
        bytes memory rawResponse,
        address provider,
        WritRegistry.RoutingProof calldata routing,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) external returns (bytes32 id, bool approved, uint8 risk) {
        return _consumeRoutingProof(policyId, params, rawResponse, provider, routing, signature, transcriptRoot);
    }
}
