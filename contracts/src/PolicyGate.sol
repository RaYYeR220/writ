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
    /// @notice Who refused an action, for the decisions that were refused.
    /// @dev Both refusals are equally final, but they mean different things and a reader deserves
    ///      to be told which happened: `Model` is the model exercising judgement, `Policy` is the
    ///      model being willing and this gate's ceiling saying no anyway.
    enum Refusal {
        None, // approved
        Model, // the model itself answered DENY
        Policy // the model answered ALLOW, above this policy's risk ceiling
    }

    /// @notice The outcome of consuming one attested verdict.
    /// @dev Returned as a struct rather than a tuple for two reasons: four return values put
    ///      `_consumeRoutingProof` over the stack limit, and a struct lets a later field be added
    ///      without silently changing what an existing destructuring binds.
    struct Decision {
        /// @dev The writ the registry recorded. On the routing path this is the routing writ,
        ///      which is NOT the key `consumed` is read at - see `decisionKey`.
        bytes32 id;
        bool approved;
        uint8 risk;
        Refusal refusedBy;
    }

    struct Policy {
        bytes promptHead;
        bytes promptTail;
        bytes32 allowedModelHash;
        address allowedProvider; // address(0) means any acknowledged TeeML provider
        uint8 maxRisk;
    }

    WritRegistry public immutable registry;

    mapping(uint256 => Policy) internal _policies;

    /// @notice Decisions this gate has already spent, keyed by `decisionKey`.
    /// @dev NOT keyed by the writ id the registry recorded. A provider, a question and an answer
    ///      make one decision, and the same decision can arrive proved in either signed-text
    ///      format. Those are two distinct writs in the registry — they attest different things
    ///      about which upstream served the request, and both deserve to be recorded — but
    ///      spending one must spend the other, or one verdict would authorise two actions.
    mapping(bytes32 => bool) public consumed;

    error ModelNotAllowed(bytes32 got, bytes32 want);
    error ProviderNotAllowed(address got, address want);
    error WritAlreadyConsumed(bytes32 id);
    /// @notice The proof has not been recorded, so there is nothing for this gate to act on.
    /// @dev Notarize it first, in its own transaction. See `_consume`.
    error WritNotNotarized(bytes32 id);
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

    /// @notice Renders this contract's decision from a proof the registry has already recorded.
    /// @dev The writ MUST be notarized first, in its own transaction. That ordering is structural,
    ///      not a client convention: a gate that notarized inline would put the permanent record
    ///      and the guarded action in one transaction, so an approval whose payout reverted would
    ///      roll the record back with it and only refusals would survive. Notarizing separately
    ///      makes every decision — approved, refused, or approved-but-unpayable — equally
    ///      permanent. A writ that is not on record reverts `WritNotNotarized`.
    ///
    ///      A failure to *satisfy* the gate reverts too: the caller has not shown a decision that
    ///      answers this contract's question. A verified refusal returns `approved == false`
    ///      instead. Fail-closed means the guarded action does not happen, not that the record
    ///      disappears.
    /// @dev `Decision.approved` and `Decision.refusedBy` always agree; the refuser is named so a
    ///      caller can tell the model declining from the policy overruling it.
    function _consume(uint256 policyId, bytes memory params, bytes memory rawResponse, address provider)
        internal
        returns (Decision memory)
    {
        (bytes32 reqHash, bytes32 respHash) = _pin(policyId, params, rawResponse, provider);

        // On this path the record and the decision are the same key.
        bytes32 id = decisionKey(provider, reqHash, respHash);
        if (consumed[id]) revert WritAlreadyConsumed(id);
        if (!registry.isNotarized(id)) revert WritNotNotarized(id);

        return _decide(policyId, id, id, rawResponse);
    }

    /// @notice `_consume` for a centralized provider, whose TEE signs the five-field routing text.
    /// @dev Identical guarantees, including the requirement that the writ already be notarized;
    ///      only the signed format and the recorded writ differ. The decision is still spent under
    ///      `decisionKey`, so a routing proof and a chat proof of the same answer cannot both
    ///      authorise an action.
    function _consumeRoutingProof(
        uint256 policyId,
        bytes memory params,
        bytes memory rawResponse,
        address provider,
        WritRegistry.RoutingProof calldata routing
    ) internal returns (Decision memory) {
        (bytes32 reqHash, bytes32 respHash) = _pin(policyId, params, rawResponse, provider);

        bytes32 decision = decisionKey(provider, reqHash, respHash);
        if (consumed[decision]) revert WritAlreadyConsumed(decision);

        bytes32 id = _routingId(provider, reqHash, respHash, routing);
        if (!registry.isNotarized(id)) revert WritNotNotarized(id);

        return _decide(policyId, id, decision, rawResponse);
    }

    /// @notice The key a decision is spent under, whichever signed-text format proved it.
    /// @dev A provider, a question and an answer are one decision. This deliberately coincides
    ///      with the chat writ id: that identifier already names exactly those three things, so
    ///      reusing it avoids inventing a second hash of the same tuple.
    function decisionKey(address provider, bytes32 reqHash, bytes32 respHash) public view returns (bytes32) {
        return registry.writId(provider, reqHash, respHash);
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
    /// @param id The writ to read the model from — a record that already exists on chain.
    /// @param decision The key to spend, which is the same as `id` only on the chat path.
    function _decide(uint256 policyId, bytes32 id, bytes32 decision, bytes memory rawResponse)
        private
        returns (Decision memory d)
    {
        Policy storage p = _policies[policyId];

        WritRegistry.Writ memory w = registry.getWrit(id);
        if (w.modelHash != p.allowedModelHash) revert ModelNotAllowed(w.modelHash, p.allowedModelHash);

        // A malformed answer is not a refusal — it is an unverifiable answer, so it reverts.
        (bool allowed, uint8 reported) = VerdictLib.parseVerdict(rawResponse);

        // The decision is rendered either way, so it is spent either way.
        consumed[decision] = true;

        d.id = id;
        d.risk = reported;
        if (!allowed) {
            d.refusedBy = Refusal.Model;
        } else if (reported > p.maxRisk) {
            d.refusedBy = Refusal.Policy;
        } else {
            d.approved = true;
        }
    }
}
