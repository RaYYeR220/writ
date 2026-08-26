// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VerdictLib} from "../../src/VerdictLib.sol";

/// @dev `VerdictLib` is an internal library, so its calls inline into the caller. Routing the
///      tests through an external boundary lets `vm.expectRevert` observe the revert.
contract VerdictLibHarness {
    function parseVerdict(bytes memory body) external pure returns (bool allowed, uint8 risk) {
        return VerdictLib.parseVerdict(body);
    }
}
