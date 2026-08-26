// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyGate} from "./PolicyGate.sol";
import {PromptLib} from "./PromptLib.sol";
import {TreasuryGate} from "./TreasuryGate.sol";
import {WritRegistry} from "./WritRegistry.sol";

/// @title PolicyGateFactory
/// @notice Deploys a configured `TreasuryGate` so a policy can be published without Solidity.
/// @dev Ownerless: the factory keeps an index of who owns what and nothing else. It has no
///      authority over a deployed gate, and a gate never consults the factory at runtime.
///
///      The factory owns ONE part of the question: the `"model"` key. `deployGate` takes a model
///      NAME, writes `{"model":"<name>",` itself, and derives `allowedModelHash` from that same
///      string, so a gate cannot ask about one model and accept an answer from another. That rule
///      lives in `PromptLib`, which `src/examples/AgentTreasury.sol` builds through too — read it
///      for why the mismatch is made unrepresentable rather than validated, and for what the
///      `"model"`-key scan does and does not promise.
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

    address[] public allGates;
    mapping(address => address[]) private _gatesByOwner;

    error EmptyPrompt();
    error ZeroAgent();
    error ZeroOwner();
    error RiskCeilingTooHigh(uint8 maxRisk);

    /// @dev `owner` holds the gate's recovery hatch; `deployer` merely paid for the deployment.
    ///      They are usually the same account, and the distinction only matters when they are not.
    event GateDeployed(address indexed gate, address indexed owner, address indexed deployer, bytes32 modelHash);

    constructor(WritRegistry registry_) {
        registry = registry_;
    }

    /// @notice The prompt head a gate will be given: the model key, then the caller's bytes.
    /// @dev Pure and public so a caller can compare it against what they meant to ask before
    ///      paying for the gate that asks it. It previews rather than validates: `deployGate`
    ///      runs the checks, and a preview that reverted would tell a caller less than the bytes
    ///      it refused to show them.
    function buildPromptHead(string memory modelName, bytes memory promptHead) public pure returns (bytes memory) {
        return PromptLib.spliceModelKey(modelName, promptHead);
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

        // One string decides both halves: the checked splice writes the model key into the
        // question, and the hash beside it is that same string.
        bytes memory head = PromptLib.buildPromptHead(spec.modelName, spec.promptHead, spec.promptTail);
        bytes32 modelHash = keccak256(bytes(spec.modelName));

        gate = address(
            new TreasuryGate(
                registry,
                agent,
                owner,
                PolicyGate.Policy({
                    promptHead: head,
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
}
