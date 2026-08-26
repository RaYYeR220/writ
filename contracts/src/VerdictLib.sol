// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title VerdictLib
/// @notice Extracts a strict verdict token from a chat-completions response body.
/// @dev Deliberately not a JSON parser. The policy constrains the model to answer with exactly
///      `ALLOW:<0-100>` or `DENY:<0-100>`, so a marker-anchored scan with a hard length cap is
///      sufficient and total. Anything that does not match the grammar exactly reverts.
library VerdictLib {
    error MarkerNotFound();
    error VerdictTooLong();
    error VerdictMalformed();

    uint256 private constant MAX_CONTENT_LEN = 32;

    /// @notice Parses the verdict from a raw response body.
    /// @return allowed True for `ALLOW`, false for `DENY`.
    /// @return risk The 0-100 risk score the model reported.
    function parseVerdict(bytes memory body) internal pure returns (bool allowed, uint8 risk) {
        uint256 start = _contentStart(body);

        uint256 end = start;
        while (end < body.length && body[end] != '"') {
            unchecked {
                if (end - start >= MAX_CONTENT_LEN) revert VerdictTooLong();
                ++end;
            }
        }
        if (end >= body.length) revert VerdictMalformed();

        uint256 len = end - start;
        uint256 digitsAt;
        if (
            len > 6 && body[start] == "A" && body[start + 1] == "L" && body[start + 2] == "L" && body[start + 3] == "O"
                && body[start + 4] == "W" && body[start + 5] == ":"
        ) {
            allowed = true;
            digitsAt = start + 6;
        } else if (
            len > 5 && body[start] == "D" && body[start + 1] == "E" && body[start + 2] == "N" && body[start + 3] == "Y"
                && body[start + 4] == ":"
        ) {
            allowed = false;
            digitsAt = start + 5;
        } else {
            revert VerdictMalformed();
        }

        uint256 value;
        uint256 digits;
        for (uint256 i = digitsAt; i < end; ++i) {
            uint8 c = uint8(body[i]);
            if (c < 0x30 || c > 0x39) revert VerdictMalformed();
            value = value * 10 + (c - 0x30);
            unchecked {
                ++digits;
            }
        }
        if (digits == 0 || digits > 3 || value > 100) revert VerdictMalformed();
        risk = uint8(value);
    }

    /// @dev Returns the index just past the first `"content":"` marker.
    function _contentStart(bytes memory body) private pure returns (uint256) {
        bytes11 marker = '"content":"';
        if (body.length < 11) revert MarkerNotFound();
        uint256 limit = body.length - 11;
        for (uint256 i = 0; i <= limit; ++i) {
            bool hit = true;
            for (uint256 j = 0; j < 11; ++j) {
                if (body[i + j] != marker[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return i + 11;
        }
        revert MarkerNotFound();
    }
}
