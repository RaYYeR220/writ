// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WritRegistry} from "./WritRegistry.sol";
import {VerdictLib} from "./VerdictLib.sol";

/// @title PolicyGate
/// @notice Base contract for gating an action behind a TEE-attested AI verdict.
/// @dev The contract builds the canonical request body itself, so the question cannot be
///      swapped: a proof only satisfies the gate if the TEE signed a response to the exact
///      question this contract would have asked for these exact parameters.
///
///      Derived contracts MUST build `params` only from typed values formatted as hex or
///      decimal. Passing caller-supplied strings through would be JSON injection into the
///      pinned question.
abstract contract PolicyGate {
    struct Policy {
        bytes promptHead;
        bytes promptTail;
        bytes32 allowedModelHash;
        address allowedProvider; // address(0) means any acknowledged TeeML provider
        uint8 maxRisk;
    }

    WritRegistry public immutable registry;

    mapping(uint256 => Policy) internal _policies;
    mapping(bytes32 => bool) public consumed;

    error ModelNotAllowed(bytes32 got, bytes32 want);
    error ProviderNotAllowed(address got, address want);
    error VerdictDenied(uint8 risk);
    error RiskTooHigh(uint8 risk, uint8 maxRisk);
    error WritAlreadyConsumed(bytes32 id);
    error UnknownPolicy(uint256 policyId);

    constructor(WritRegistry registry_) {
        registry = registry_;
    }

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return _policies[policyId];
    }

    /// @notice The exact request body a client must post to the provider.
    /// @dev Clients call this and send the returned bytes verbatim. They must never rebuild
    ///      the body themselves — this contract is the single source of truth for the question.
    function buildRequestBody(uint256 policyId, bytes memory params) public view returns (bytes memory) {
        Policy storage p = _policies[policyId];
        if (p.promptHead.length == 0) revert UnknownPolicy(policyId);
        return abi.encodePacked(p.promptHead, params, p.promptTail);
    }

    function _setPolicy(uint256 policyId, Policy memory p) internal {
        _policies[policyId] = p;
    }

    /// @notice Verifies a proof answers this contract's own question, then enforces the verdict.
    /// @return id The writ identifier, now marked consumed.
    /// @return risk The approved risk score.
    function _consume(
        uint256 policyId,
        bytes memory params,
        bytes memory rawResponse,
        address provider,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) internal returns (bytes32 id, uint8 risk) {
        Policy storage p = _policies[policyId];
        if (p.promptHead.length == 0) revert UnknownPolicy(policyId);
        if (p.allowedProvider != address(0) && p.allowedProvider != provider) {
            revert ProviderNotAllowed(provider, p.allowedProvider);
        }

        bytes32 reqHash = sha256(buildRequestBody(policyId, params));
        bytes32 respHash = sha256(rawResponse);

        id = registry.writId(provider, reqHash, respHash);
        if (consumed[id]) revert WritAlreadyConsumed(id);

        // Notarizing is a public good; someone else may already have done it.
        if (!registry.isNotarized(id)) {
            registry.notarize(provider, reqHash, respHash, signature, transcriptRoot);
        }

        WritRegistry.Writ memory w = registry.getWrit(id);
        if (w.modelHash != p.allowedModelHash) revert ModelNotAllowed(w.modelHash, p.allowedModelHash);

        (bool allowed, uint8 reported) = VerdictLib.parseVerdict(rawResponse);
        if (!allowed) revert VerdictDenied(reported);
        if (reported > p.maxRisk) revert RiskTooHigh(reported, p.maxRisk);

        consumed[id] = true;
        risk = reported;
    }
}
