// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WritLib} from "./WritLib.sol";
import {IInferenceServing} from "./interfaces/IInferenceServing.sol";

/// @title WritRegistry
/// @notice Permanent public record of verified 0G Compute TEE inference proofs.
/// @dev Ownerless and non-upgradeable. Validity is decided entirely by the TEE signature and
///      0G's official InferenceServing registry, which is read live on every call. There is no
///      allowlist: anyone may notarize any valid proof.
///
///      Two proof kinds are accepted, matching the two signed-text formats the 0G broker
///      produces for text inference: `notarize` for a decentralized provider's chat proof and
///      `notarizeRoutingProof` for a centralized provider's five-field routing proof. Their
///      identifiers are domain-separated so the same request/response pair can hold both.
contract WritRegistry {
    struct Writ {
        address provider;
        bytes32 modelHash;
        bytes32 reqHash;
        bytes32 respHash;
        bytes32 transcriptRoot;
        uint64 notarizedAt;
        address notarizedBy;
    }

    /// @notice The upstream attribution a centralized provider's routing proof binds.
    /// @dev Only populated for writs notarized through `notarizeRoutingProof`; its presence is
    ///      what distinguishes the two kinds. The TLS fingerprint proves which upstream actually
    ///      served the request, which the chat format does not attest at all.
    struct RoutingProof {
        string providerType;
        string providerIdentity;
        bytes32 tlsFingerprint;
    }

    /// @notice 0G's official inference service registry.
    IInferenceServing public immutable serving;

    bytes32 private constant TEE_ML = keccak256(bytes("TeeML"));

    /// @dev Domain tag that keeps a routing writ from colliding with a plain one over the same
    ///      provider, request and response.
    bytes32 private constant ROUTING_PROOF_DOMAIN = keccak256("writ.routingProof.v1");

    /// @dev Generous for `"centralized"` and for any upstream label the broker uses.
    uint256 private constant MAX_ROUTING_FIELD = 32;

    mapping(bytes32 => Writ) private _writs;
    mapping(bytes32 => RoutingProof) private _routingProofs;
    uint256 public writCount;

    error NotTeeVerifiable(address provider, string verifiability);
    error SignerNotAcknowledged(address provider);
    error BadSignature(address recovered, address expected);
    error AlreadyNotarized(bytes32 id);
    error NotNotarized(bytes32 id);
    error NotARoutingProof(bytes32 id);
    error RoutingFieldEmpty();
    error RoutingFieldTooLong(uint256 length);
    error RoutingFieldHasDelimiter();

    event Notarized(
        bytes32 indexed id,
        address indexed provider,
        bytes32 indexed modelHash,
        string model,
        bytes32 reqHash,
        bytes32 respHash,
        bytes32 transcriptRoot,
        address notarizedBy
    );

    event RoutingProofNotarized(
        bytes32 indexed id,
        address indexed provider,
        string providerType,
        string providerIdentity,
        bytes32 tlsFingerprint
    );

    constructor(address serving_) {
        serving = IInferenceServing(serving_);
    }

    /// @notice Content-addressed identifier of a chat proof.
    function writId(address provider, bytes32 reqHash, bytes32 respHash) public pure returns (bytes32) {
        return keccak256(abi.encode(provider, reqHash, respHash));
    }

    /// @notice Content-addressed identifier of a centralized routing proof.
    /// @dev Domain-tagged and over a longer preimage than `writId`, so the two kinds cannot
    ///      collide. The attribution fields are part of the identifier because they are part of
    ///      what the TEE signed: a proof recorded under a different upstream is a different fact.
    function routingWritId(
        address provider,
        bytes32 reqHash,
        bytes32 respHash,
        string memory providerType,
        string memory providerIdentity,
        bytes32 tlsFingerprint
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ROUTING_PROOF_DOMAIN,
                provider,
                reqHash,
                respHash,
                keccak256(bytes(providerType)),
                keccak256(bytes(providerIdentity)),
                tlsFingerprint
            )
        );
    }

    function isNotarized(bytes32 id) public view returns (bool) {
        return _writs[id].notarizedAt != 0;
    }

    /// @notice Whether this writ was recorded from a centralized provider's routing proof.
    function isRoutingProof(bytes32 id) public view returns (bool) {
        return bytes(_routingProofs[id].providerType).length != 0;
    }

    function getWrit(bytes32 id) external view returns (Writ memory w) {
        w = _writs[id];
        if (w.notarizedAt == 0) revert NotNotarized(id);
    }

    function getRoutingProof(bytes32 id) external view returns (RoutingProof memory p) {
        p = _routingProofs[id];
        if (bytes(p.providerType).length == 0) revert NotARoutingProof(id);
    }

    /// @notice Verify a TEE inference proof and record it forever.
    /// @param provider The 0G Compute provider that served the request.
    /// @param reqHash sha256 of the exact request body bytes sent to the provider.
    /// @param respHash sha256 of the exact response body bytes returned by the provider.
    /// @param signature The provider's TEE signature over `sha256hex(req):sha256hex(resp)`.
    /// @param transcriptRoot 0G Storage merkle root of the archived transcript.
    function notarize(
        address provider,
        bytes32 reqHash,
        bytes32 respHash,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) external returns (bytes32 id) {
        id = writId(provider, reqHash, respHash);
        IInferenceServing.Service memory svc = _teeService(id, provider);
        _requireSigner(WritLib.recoverSigner(reqHash, respHash, signature), svc.teeSignerAddress);
        _record(id, provider, svc.model, reqHash, respHash, transcriptRoot);
    }

    /// @notice Verify a centralized provider's routing proof and record it forever.
    /// @dev Same registry checks as `notarize`; only the signed text differs. The extra fields
    ///      are recorded because they are the stronger part of this proof: the TLS fingerprint
    ///      names the upstream that actually answered.
    ///
    ///      `providerType` and `providerIdentity` are not a trust input — the signature covers
    ///      them, so a wrong value simply fails recovery. They are validated anyway because the
    ///      `:`-joined text is ambiguous under field splitting: `("x", "y:z")` and `("x:y", "z")`
    ///      sign the same bytes, which would let one valid proof be recorded under mis-attributed
    ///      metadata. The broker relies on the fingerprint provably being 32 hex bytes for the
    ///      same reason; the two free-text fields get the equivalent guarantee here.
    ///
    ///      We deliberately do NOT cross-check these against the service's `additionalInfo` JSON.
    ///      The signature already binds them, so parsing JSON on chain would add attack surface
    ///      for no security gain.
    function notarizeRoutingProof(
        address provider,
        bytes32 reqHash,
        bytes32 respHash,
        string calldata providerType,
        string calldata providerIdentity,
        bytes32 tlsFingerprint,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) external returns (bytes32 id) {
        _requireLabel(providerType);
        _requireLabel(providerIdentity);

        id = routingWritId(provider, reqHash, respHash, providerType, providerIdentity, tlsFingerprint);
        IInferenceServing.Service memory svc = _teeService(id, provider);
        _requireSigner(
            WritLib.recoverRoutingProofSigner(
                reqHash, respHash, providerType, providerIdentity, tlsFingerprint, signature
            ),
            svc.teeSignerAddress
        );

        _routingProofs[id] = RoutingProof(providerType, providerIdentity, tlsFingerprint);
        _record(id, provider, svc.model, reqHash, respHash, transcriptRoot);

        emit RoutingProofNotarized(id, provider, providerType, providerIdentity, tlsFingerprint);
    }

    /// @dev Reads 0G's live registry and enforces that the provider is a TEE service we accept.
    function _teeService(bytes32 id, address provider) private view returns (IInferenceServing.Service memory svc) {
        if (_writs[id].notarizedAt != 0) revert AlreadyNotarized(id);

        svc = serving.getService(provider);
        if (!svc.teeSignerAcknowledged) revert SignerNotAcknowledged(provider);
        if (keccak256(bytes(svc.verifiability)) != TEE_ML) {
            revert NotTeeVerifiable(provider, svc.verifiability);
        }
    }

    function _requireSigner(address recovered, address expected) private pure {
        if (recovered != expected) revert BadSignature(recovered, expected);
    }

    /// @dev A label may not be empty, may not exceed `MAX_ROUTING_FIELD`, and may not contain the
    ///      `:` that separates the fields it sits between.
    function _requireLabel(string calldata label) private pure {
        bytes calldata raw = bytes(label);
        if (raw.length == 0) revert RoutingFieldEmpty();
        if (raw.length > MAX_ROUTING_FIELD) revert RoutingFieldTooLong(raw.length);
        for (uint256 i = 0; i < raw.length; ++i) {
            if (raw[i] == ":") revert RoutingFieldHasDelimiter();
        }
    }

    /// @dev The model name is stored as a hash and emitted raw, so indexers get the string for
    ///      free while storage stays one slot.
    function _record(
        bytes32 id,
        address provider,
        string memory model,
        bytes32 reqHash,
        bytes32 respHash,
        bytes32 transcriptRoot
    ) private {
        bytes32 modelHash = keccak256(bytes(model));
        _writs[id] = Writ({
            provider: provider,
            modelHash: modelHash,
            reqHash: reqHash,
            respHash: respHash,
            transcriptRoot: transcriptRoot,
            notarizedAt: uint64(block.timestamp),
            notarizedBy: msg.sender
        });
        unchecked {
            ++writCount;
        }

        emit Notarized(id, provider, modelHash, model, reqHash, respHash, transcriptRoot, msg.sender);
    }
}
