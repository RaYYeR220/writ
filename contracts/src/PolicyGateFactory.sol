// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyGate} from "./PolicyGate.sol";
import {TreasuryGate} from "./TreasuryGate.sol";
import {WritRegistry} from "./WritRegistry.sol";

/// @title PolicyGateFactory
/// @notice Deploys a configured `TreasuryGate` so a policy can be published without Solidity.
/// @dev Ownerless: the factory keeps an index of who deployed what and nothing else. It has no
///      authority over a deployed gate, and a gate never consults the factory at runtime.
contract PolicyGateFactory {
    /// @notice The registry every gate this factory deploys will verify against.
    WritRegistry public immutable registry;

    address[] public allGates;
    mapping(address => address[]) private _gatesByOwner;

    error EmptyPrompt();
    error ZeroAgent();
    error RiskCeilingTooHigh(uint8 maxRisk);

    event GateDeployed(address indexed gate, address indexed owner, bytes32 modelHash);

    constructor(WritRegistry registry_) {
        registry = registry_;
    }

    /// @notice Deploy a gate that enforces `p` for `agent`.
    /// @dev The policy is copied into the gate's storage at construction and is not governable
    ///      afterwards, so what the gate asks is fixed the moment it exists.
    function deployGate(PolicyGate.Policy calldata p, address agent) external returns (address gate) {
        if (p.promptHead.length == 0) revert EmptyPrompt();
        if (agent == address(0)) revert ZeroAgent();
        // A ceiling above 100 would wave through every verdict the grammar can express.
        if (p.maxRisk > 100) revert RiskCeilingTooHigh(p.maxRisk);

        // The deployer is the gate's owner, and so the only holder of its recovery hatch.
        gate = address(new TreasuryGate(registry, agent, msg.sender, p));

        allGates.push(gate);
        _gatesByOwner[msg.sender].push(gate);

        emit GateDeployed(gate, msg.sender, p.allowedModelHash);
    }

    function gatesOf(address owner) external view returns (address[] memory) {
        return _gatesByOwner[owner];
    }

    function gateCount() external view returns (uint256) {
        return allGates.length;
    }
}
