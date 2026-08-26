// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title PromptLib
/// @notice Composes the `"model"` key of a gate's pinned question, and guards the splice.
/// @dev A gate has two halves that must agree: the model its question names, and the
///      `allowedModelHash` its writs are checked against. They used to arrive as unrelated
///      arguments, and a gate whose halves disagreed asked about one model and accepted an answer
///      from another — every check passing, the pinned question quietly false, and nothing on
///      chain able to reconcile them afterwards, because `PolicyGate` compares the hash against
///      0G's registry and never reads the prompt.
///
///      So the mismatch is made unrepresentable rather than validated. Everything that builds a
///      gate takes a model NAME, writes `{"model":"<name>",` from it, and derives the hash from
///      that same string. This library is that one implementation: `PolicyGateFactory` and
///      `AgentTreasury` both come through here, because two copies of this rule is how the
///      original defect happened.
library PromptLib {
    /// @dev Long enough for every 0G model name in existence and short enough to bound the scan.
    uint256 internal constant MAX_MODEL_NAME = 64;

    error ModelNameEmpty();
    error ModelNameTooLong(uint256 length);
    error ModelNameHasIllegalByte(uint256 index);
    error ModelKeyInPrompt();

    /// @notice The model key, then the author's bytes. No checks — this is the splice itself.
    /// @dev Exposed separately so a preview can show what a build would produce without being
    ///      able to revert. `buildPromptHead` is what a gate is actually built through.
    function spliceModelKey(string memory modelName, bytes memory promptHead) internal pure returns (bytes memory) {
        return abi.encodePacked('{"model":"', modelName, '",', promptHead);
    }

    /// @notice The prompt head a gate stores: checked, then spliced.
    /// @dev Takes the tail as well because the tail is the other half of the author's JSON and a
    ///      second `"model"` key hides there just as easily. The caller pairs the returned head
    ///      with `keccak256(bytes(modelName))`; passing anything else would put the disagreement
    ///      back.
    function buildPromptHead(string memory modelName, bytes memory promptHead, bytes memory promptTail)
        internal
        pure
        returns (bytes memory)
    {
        requireModelName(modelName);
        requireNoModelKey(promptHead);
        requireNoModelKey(promptTail);
        return spliceModelKey(modelName, promptHead);
    }

    /// @dev The name is spliced into a JSON string literal, so anything that could end that
    ///      literal early would let the rest be read as structure — an author could rewrite the
    ///      messages array from inside what looks like a model name. Reject the two bytes that
    ///      do it (`"` and `\`) and every control byte, which a JSON string may not carry raw
    ///      anyway.
    function requireModelName(string memory modelName) internal pure {
        bytes memory raw = bytes(modelName);
        if (raw.length == 0) revert ModelNameEmpty();
        if (raw.length > MAX_MODEL_NAME) revert ModelNameTooLong(raw.length);
        for (uint256 i = 0; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            if (c == 0x22 || c == 0x5C || c < 0x20) revert ModelNameHasIllegalByte(i);
        }
    }

    /// @dev Rejects `"model"` anywhere in the bytes the author controls. JSON leaves duplicate
    ///      keys to the parser, so a second one could win and the provider would run a model the
    ///      gate never named.
    ///
    ///      Be honest about the strength of this: it is a byte scan, not a JSON parser. An
    ///      escaped spelling (`"model"`) would pass it. What makes that survivable is that
    ///      the model hash comes from `modelName` alone — a smuggled key can make a provider run
    ///      something else, but the gate then refuses every writ that comes back, so the result
    ///      is a dead gate rather than a lying one. This check is here to catch the accident and
    ///      the obvious attempt; the structural guarantee is the shared string.
    function requireNoModelKey(bytes memory prompt) internal pure {
        bytes7 needle = '"model"';
        if (prompt.length < 7) return;
        uint256 limit = prompt.length - 7;
        for (uint256 i = 0; i <= limit; ++i) {
            bool hit = true;
            for (uint256 j = 0; j < 7; ++j) {
                if (prompt[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) revert ModelKeyInPrompt();
        }
    }
}
