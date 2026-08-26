// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WritLib} from "./WritLib.sol";
import {IInferenceServing} from "./interfaces/IInferenceServing.sol";

/// @title WritRegistry
/// @notice Permanent public record of verified 0G Compute TEE inference proofs.
/// @dev Ownerless and non-upgradeable. Validity is decided entirely by the TEE signature and
///      0G's official InferenceServing registry, which is read live on every call. There is no
///      allowlist: anyone may notarize any valid proof.
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

    /// @notice 0G's official inference service registry.
    IInferenceServing public immutable serving;

    bytes32 private constant TEE_ML = keccak256(bytes("TeeML"));

    mapping(bytes32 => Writ) private _writs;
    uint256 public writCount;

    error NotTeeVerifiable(address provider, string verifiability);
    error SignerNotAcknowledged(address provider);
    error BadSignature(address recovered, address expected);
    error AlreadyNotarized(bytes32 id);
    error NotNotarized(bytes32 id);

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

    constructor(address serving_) {
        serving = IInferenceServing(serving_);
    }

    /// @notice Content-addressed identifier of a proof.
    function writId(address provider, bytes32 reqHash, bytes32 respHash) public pure returns (bytes32) {
        return keccak256(abi.encode(provider, reqHash, respHash));
    }

    function isNotarized(bytes32 id) public view returns (bool) {
        return _writs[id].notarizedAt != 0;
    }

    function getWrit(bytes32 id) external view returns (Writ memory w) {
        w = _writs[id];
        if (w.notarizedAt == 0) revert NotNotarized(id);
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
        if (_writs[id].notarizedAt != 0) revert AlreadyNotarized(id);

        IInferenceServing.Service memory svc = serving.getService(provider);
        if (!svc.teeSignerAcknowledged) revert SignerNotAcknowledged(provider);
        if (keccak256(bytes(svc.verifiability)) != TEE_ML) {
            revert NotTeeVerifiable(provider, svc.verifiability);
        }

        address recovered = WritLib.recoverSigner(reqHash, respHash, signature);
        if (recovered != svc.teeSignerAddress) {
            revert BadSignature(recovered, svc.teeSignerAddress);
        }

        bytes32 modelHash = keccak256(bytes(svc.model));
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

        emit Notarized(id, provider, modelHash, svc.model, reqHash, respHash, transcriptRoot, msg.sender);
    }
}
