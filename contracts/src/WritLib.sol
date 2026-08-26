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
    function recoverSigner(bytes32 reqHash, bytes32 respHash, bytes memory signature)
        internal
        pure
        returns (address)
    {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(signedText(reqHash, respHash));
        return ECDSA.recover(digest, signature);
    }
}
