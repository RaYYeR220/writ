// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyGate} from "./PolicyGate.sol";
import {TreasuryGate} from "./TreasuryGate.sol";
import {WritRegistry} from "./WritRegistry.sol";

/// @title PolicyGateFactory
/// @notice Deploys a configured `TreasuryGate` so a policy can be published without Solidity.
/// @dev Ownerless: the factory keeps an index of who owns what and nothing else. It has no
///      authority over a deployed gate, and a gate never consults the factory at runtime.
contract PolicyGateFactory {
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

    /// @notice Deploy a gate that enforces `p` for `agent`, owned by `owner`.
    /// @dev The policy is copied into the gate's storage at construction and is not governable
    ///      afterwards, so what the gate asks is fixed the moment it exists.
    /// @param owner Who may take the gate's timelocked recovery hatch. Named explicitly rather
    ///        than defaulted to `msg.sender`, because deploying a gate on someone else's behalf
    ///        would otherwise hand the deployer a claim on funds they do not own. Pass your own
    ///        address for the ordinary case.
    function deployGate(PolicyGate.Policy calldata p, address agent, address owner) external returns (address gate) {
        if (p.promptHead.length == 0) revert EmptyPrompt();
        if (agent == address(0)) revert ZeroAgent();
        if (owner == address(0)) revert ZeroOwner();
        // A ceiling above 100 would wave through every verdict the grammar can express.
        if (p.maxRisk > 100) revert RiskCeilingTooHigh(p.maxRisk);

        gate = address(new TreasuryGate(registry, agent, owner, p));

        allGates.push(gate);
        _gatesByOwner[owner].push(gate);

        emit GateDeployed(gate, owner, msg.sender, p.allowedModelHash);
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
