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

    function consume(uint256 policyId, bytes memory params, bytes memory rawResponse, address provider)
        external
        returns (bytes32 id, bool approved, uint8 risk, Refusal refusedBy)
    {
        Decision memory d = _consume(policyId, params, rawResponse, provider);
        return (d.id, d.approved, d.risk, d.refusedBy);
    }

    function consumeRoutingProof(
        uint256 policyId,
        bytes memory params,
        bytes memory rawResponse,
        address provider,
        WritRegistry.RoutingProof calldata routing
    ) external returns (bytes32 id, bool approved, uint8 risk, Refusal refusedBy) {
        Decision memory d = _consumeRoutingProof(policyId, params, rawResponse, provider, routing);
        return (d.id, d.approved, d.risk, d.refusedBy);
    }
}
