// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PromptLib} from "../../src/PromptLib.sol";

/// @dev `PromptLib` is an internal library, so its calls inline into the caller. Routing the
///      tests through an external boundary lets `vm.expectRevert` observe the revert, and lets
///      the rule be exercised on its own rather than only through a deployment that uses it.
contract PromptLibHarness {
    function spliceModelKey(string memory modelName, bytes memory promptHead) external pure returns (bytes memory) {
        return PromptLib.spliceModelKey(modelName, promptHead);
    }

    function buildPromptHead(string memory modelName, bytes memory promptHead, bytes memory promptTail)
        external
        pure
        returns (bytes memory)
    {
        return PromptLib.buildPromptHead(modelName, promptHead, promptTail);
    }

    function requireModelName(string memory modelName) external pure {
        PromptLib.requireModelName(modelName);
    }

    function requireNoModelKey(bytes memory prompt) external pure {
        PromptLib.requireNoModelKey(prompt);
    }
}
