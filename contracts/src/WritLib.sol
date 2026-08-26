// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title WritLib
/// @notice Verifies a 0G Compute TEE inference proof on chain.
/// @dev A 0G provider broker signs `sha256hex(requestBody):sha256hex(responseBody)` with the
///      TEE's secp256k1 key using the EIP-191 personal-sign prefix. Because both sides are
///      bound in one signature, a caller that knows the raw bytes can prove the question as
///      well as the answer.
///
///      The broker signs three different texts depending on how the request was served:
///        1. chatbot / video / speech on a decentralized provider -> `signedText`, 129 bytes.
///        2. image generation -> `sha256hex(req):sha256hex(img0),sha256hex(img1),...`.
///        3. any centralized provider -> `routingProofText`, five `:`-joined fields.
///      Formats 1 and 3 are implemented here. Format 2 is deliberately NOT supported: its
///      comma-joined image list needs its own binding rules, and a half-implementation would
///      verify signatures over a text whose meaning we have not pinned down.
library WritLib {
    bytes16 private constant HEX_DIGITS = "0123456789abcdef";

    /// @notice Lowercase, zero-padded hex of a bytes32 with no `0x` prefix.
    /// @dev Byte-identical to Go's `hex.EncodeToString`, which is what the broker uses.
    function hex64(bytes32 value) internal pure returns (bytes memory out) {
        out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(value[i]);
            out[i * 2] = HEX_DIGITS[b >> 4];
            out[i * 2 + 1] = HEX_DIGITS[b & 0x0f];
        }
    }

    /// @notice Rebuilds the exact 129-byte text the TEE signed.
    function signedText(bytes32 reqHash, bytes32 respHash) internal pure returns (bytes memory) {
        return abi.encodePacked(hex64(reqHash), ":", hex64(respHash));
    }

    /// @notice Recovers the TEE signing address from a proof.
    /// @return The recovered address. Callers must compare it to the provider's registered signer.
    function recoverSigner(bytes32 reqHash, bytes32 respHash, bytes memory signature) internal pure returns (address) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(signedText(reqHash, respHash));
        return ECDSA.recover(digest, signature);
    }

    /// @notice Rebuilds the text a centralized provider's TEE signs for a routing proof.
    /// @dev Byte-identical to `FormatRoutingProofText` in the broker's `api/common/tee/tls.go`:
    ///      `req:resp:providerType:providerIdentity:tlsCertFingerprint`. The broker normalises the
    ///      fingerprint to exactly 32 hex-encoded bytes, so `hex64` reproduces it and, like the
    ///      two content hashes, it provably cannot smuggle a `:` into the field split. The two
    ///      label fields are free text, so a caller must bound them itself — see `WritRegistry`.
    ///
    ///      This binds more than the chat format does: the TLS certificate fingerprint proves
    ///      which upstream actually served the request.
    function routingProofText(
        bytes32 reqHash,
        bytes32 respHash,
        string memory providerType,
        string memory providerIdentity,
        bytes32 tlsFingerprint
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex64(reqHash), ":", hex64(respHash), ":", providerType, ":", providerIdentity, ":", hex64(tlsFingerprint)
        );
    }

    /// @notice Recovers the TEE signing address from a centralized routing proof.
    /// @dev The text is variable length, which is fine: `toEthSignedMessageHash` derives the
    ///      EIP-191 decimal length prefix from the bytes rather than assuming a fixed one.
    function recoverRoutingProofSigner(
        bytes32 reqHash,
        bytes32 respHash,
        string memory providerType,
        string memory providerIdentity,
        bytes32 tlsFingerprint,
        bytes memory signature
    ) internal pure returns (address) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            routingProofText(reqHash, respHash, providerType, providerIdentity, tlsFingerprint)
        );
        return ECDSA.recover(digest, signature);
    }
}
