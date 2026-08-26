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

    /// @notice Verifies a proof answers this contract's own question, then renders its decision.
    /// @dev A failure to *verify* reverts: the caller has not shown a decision at all. A verified
    ///      refusal returns `approved == false` instead, so the notarization survives and the
    ///      record is permanent. Fail-closed means the guarded action does not happen, not that
    ///      the transaction disappears.
    /// @return id The writ identifier, now marked consumed whichever way the decision went.
    /// @return approved True only for an ALLOW within the policy's risk ceiling.
    /// @return risk The risk score the model reported.
    function _consume(
        uint256 policyId,
        bytes memory params,
        bytes memory rawResponse,
        address provider,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) internal returns (bytes32 id, bool approved, uint8 risk) {
        (bytes32 reqHash, bytes32 respHash) = _pin(policyId, params, rawResponse, provider);

        id = registry.writId(provider, reqHash, respHash);
        if (consumed[id]) revert WritAlreadyConsumed(id);

        // Notarizing is a public good; someone else may already have done it.
        if (!registry.isNotarized(id)) {
            registry.notarize(provider, reqHash, respHash, signature, transcriptRoot);
        }

        (approved, risk) = _decide(policyId, id, rawResponse);
    }

    /// @notice `_consume` for a centralized provider, whose TEE signs the five-field routing text.
    /// @dev Identical guarantees; only the signed format and the writ identifier differ.
    function _consumeRoutingProof(
        uint256 policyId,
        bytes memory params,
        bytes memory rawResponse,
        address provider,
        WritRegistry.RoutingProof calldata routing,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) internal returns (bytes32 id, bool approved, uint8 risk) {
        (bytes32 reqHash, bytes32 respHash) = _pin(policyId, params, rawResponse, provider);

        id = _routingId(provider, reqHash, respHash, routing);
        if (consumed[id]) revert WritAlreadyConsumed(id);

        if (!registry.isNotarized(id)) {
            _notarizeRouting(provider, reqHash, respHash, routing, signature, transcriptRoot);
        }

        (approved, risk) = _decide(policyId, id, rawResponse);
    }

    function _routingId(address provider, bytes32 reqHash, bytes32 respHash, WritRegistry.RoutingProof calldata routing)
        private
        view
        returns (bytes32)
    {
        return registry.routingWritId(
            provider, reqHash, respHash, routing.providerType, routing.providerIdentity, routing.tlsFingerprint
        );
    }

    function _notarizeRouting(
        address provider,
        bytes32 reqHash,
        bytes32 respHash,
        WritRegistry.RoutingProof calldata routing,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) private {
        registry.notarizeRoutingProof(
            provider,
            reqHash,
            respHash,
            routing.providerType,
            routing.providerIdentity,
            routing.tlsFingerprint,
            signature,
            transcriptRoot
        );
    }

    /// @dev Pins the question: the request body is this contract's own, so the hashes a proof
    ///      must match are not the caller's to choose.
    function _pin(uint256 policyId, bytes memory params, bytes memory rawResponse, address provider)
        private
        view
        returns (bytes32 reqHash, bytes32 respHash)
    {
        Policy storage p = _policies[policyId];
        if (p.promptHead.length == 0) revert UnknownPolicy(policyId);
        if (p.allowedProvider != address(0) && p.allowedProvider != provider) {
            revert ProviderNotAllowed(provider, p.allowedProvider);
        }

        reqHash = sha256(buildRequestBody(policyId, params));
        respHash = sha256(rawResponse);
    }

    /// @dev Reads the notarized record back, enforces the policy's model, and renders the verdict.
    function _decide(uint256 policyId, bytes32 id, bytes memory rawResponse)
        private
        returns (bool approved, uint8 risk)
    {
        Policy storage p = _policies[policyId];

        WritRegistry.Writ memory w = registry.getWrit(id);
        if (w.modelHash != p.allowedModelHash) revert ModelNotAllowed(w.modelHash, p.allowedModelHash);

        // A malformed answer is not a refusal — it is an unverifiable answer, so it reverts.
        (bool allowed, uint8 reported) = VerdictLib.parseVerdict(rawResponse);

        // The decision is rendered either way, so the writ is spent either way.
        consumed[id] = true;
        risk = reported;
        approved = allowed && reported <= p.maxRisk;
    }
}
