// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyGate} from "./PolicyGate.sol";
import {TreasuryGate} from "./TreasuryGate.sol";
import {WritRegistry} from "./WritRegistry.sol";

/// @title PolicyGateFactory
/// @notice Deploys a configured `TreasuryGate` so a policy can be published without Solidity.
/// @dev Ownerless: the factory keeps an index of who owns what and nothing else. It has no
///      authority over a deployed gate, and a gate never consults the factory at runtime.
///
///      The factory owns ONE part of the question: the `"model"` key. A gate has two halves that
///      must agree — the model its question names, and the `allowedModelHash` its writs are
///      checked against — and they used to arrive as unrelated arguments. A caller who set them
///      differently got a gate that asked about one model and accepted an answer from another,
///      with every check passing and the pinned question quietly false. Nothing on chain could
///      detect it afterwards, because `PolicyGate` compares the hash against 0G's registry and
///      never reads the prompt.
///
///      So the mismatch is made unrepresentable rather than validated: `deployGate` takes a
///      model NAME, writes `{"model":"<name>",` itself, and derives `allowedModelHash` from that
///      same string. There is one source of truth and no argument that can disagree with it.
contract PolicyGateFactory {
    /// @notice What a caller supplies to get a gate.
    /// @dev `promptHead` and `promptTail` are the caller's, but they surround the model key
    ///      rather than containing it: the factory prepends `{"model":"<modelName>",` and the
    ///      caller's head continues from there (`"temperature":0,"messages":[...`). See
    ///      `buildPromptHead`, which is public so the exact question can be read before paying
    ///      for a gate that asks it.
    struct GateSpec {
        string modelName;
        bytes promptHead;
        bytes promptTail;
        address allowedProvider; // address(0) means any acknowledged TeeML provider
        uint8 maxRisk;
    }

    /// @notice The registry every gate this factory deploys will verify against.
    WritRegistry public immutable registry;

    /// @dev Long enough for every 0G model name in existence and short enough to bound the scan.
    uint256 private constant MAX_MODEL_NAME = 64;

    address[] public allGates;
    mapping(address => address[]) private _gatesByOwner;

    error EmptyPrompt();
    error ZeroAgent();
    error ZeroOwner();
    error RiskCeilingTooHigh(uint8 maxRisk);
    error ModelNameEmpty();
    error ModelNameTooLong(uint256 length);
    error ModelNameHasIllegalByte(uint256 index);
    error ModelKeyInPrompt();

    /// @dev `owner` holds the gate's recovery hatch; `deployer` merely paid for the deployment.
    ///      They are usually the same account, and the distinction only matters when they are not.
    event GateDeployed(address indexed gate, address indexed owner, address indexed deployer, bytes32 modelHash);

    constructor(WritRegistry registry_) {
        registry = registry_;
    }

    /// @notice The prompt head a gate will be given: the model key, then the caller's bytes.
    /// @dev Pure and public so a caller can compare it against what they meant to ask, and so
    ///      the splice is testable on its own rather than only through a deployment.
    function buildPromptHead(string memory modelName, bytes memory promptHead) public pure returns (bytes memory) {
        return abi.encodePacked('{"model":"', modelName, '",', promptHead);
    }

    /// @notice Deploy a gate that enforces `spec` for `agent`, owned by `owner`.
    /// @dev The policy is copied into the gate's storage at construction and is not governable
    ///      afterwards, so what the gate asks is fixed the moment it exists.
    /// @param owner Who may take the gate's timelocked recovery hatch. Named explicitly rather
    ///        than defaulted to `msg.sender`, because deploying a gate on someone else's behalf
    ///        would otherwise hand the deployer a claim on funds they do not own. Pass your own
    ///        address for the ordinary case.
    function deployGate(GateSpec calldata spec, address agent, address owner) external returns (address gate) {
        if (spec.promptHead.length == 0) revert EmptyPrompt();
        if (agent == address(0)) revert ZeroAgent();
        if (owner == address(0)) revert ZeroOwner();
        // A ceiling above 100 would wave through every verdict the grammar can express.
        if (spec.maxRisk > 100) revert RiskCeilingTooHigh(spec.maxRisk);

        _requireModelName(spec.modelName);
        _requireNoModelKey(spec.promptHead);
        _requireNoModelKey(spec.promptTail);

        bytes32 modelHash = keccak256(bytes(spec.modelName));
        gate = address(
            new TreasuryGate(
                registry,
                agent,
                owner,
                PolicyGate.Policy({
                    promptHead: buildPromptHead(spec.modelName, spec.promptHead),
                    promptTail: spec.promptTail,
                    allowedModelHash: modelHash,
                    allowedProvider: spec.allowedProvider,
                    maxRisk: spec.maxRisk
                })
            )
        );

        allGates.push(gate);
        _gatesByOwner[owner].push(gate);

        emit GateDeployed(gate, owner, msg.sender, modelHash);
    }

    /// @notice The gates `owner` owns — indexed by the owner named at deployment, not by whoever
    ///         sent the deployment transaction.
    function gatesOf(address owner) external view returns (address[] memory) {
        return _gatesByOwner[owner];
    }

    function gateCount() external view returns (uint256) {
        return allGates.length;
    }

    /// @dev The name is spliced into a JSON string literal, so anything that could end that
    ///      literal early would let the rest be read as structure — a caller could rewrite the
    ///      messages array from inside what looks like a model name. Reject the two bytes that
    ///      do it (`"` and `\`) and every control byte, which a JSON string may not carry raw
    ///      anyway.
    function _requireModelName(string calldata modelName) private pure {
        bytes calldata raw = bytes(modelName);
        if (raw.length == 0) revert ModelNameEmpty();
        if (raw.length > MAX_MODEL_NAME) revert ModelNameTooLong(raw.length);
        for (uint256 i = 0; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            if (c == 0x22 || c == 0x5C || c < 0x20) revert ModelNameHasIllegalByte(i);
        }
    }

    /// @dev Rejects `"model"` anywhere in the bytes the caller controls. JSON leaves duplicate
    ///      keys to the parser, so a second one could win and the provider would run a model the
    ///      gate never named.
    ///
    ///      Be honest about the strength of this: it is a byte scan, not a JSON parser. An
    ///      escaped spelling (`"model"`) would pass it. What makes that survivable is that
    ///      `allowedModelHash` comes from `modelName` alone — a smuggled key can make a provider
    ///      run something else, but the gate then refuses every writ that comes back, so the
    ///      result is a dead gate rather than a lying one. This check is here to catch the
    ///      accident and the obvious attempt; the structural guarantee is the shared string.
    function _requireNoModelKey(bytes calldata prompt) private pure {
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
