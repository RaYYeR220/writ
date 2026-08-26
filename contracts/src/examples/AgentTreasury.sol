// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreasuryGate} from "../TreasuryGate.sol";
import {WritRegistry} from "../WritRegistry.sol";

/// @title AgentTreasury
/// @notice The reference treasury gate: a ready-made policy an agent can be pointed at.
/// @dev Everything except the model, provider and risk ceiling is fixed here, so the question
///      the contract pins is visible in the source rather than in deployment parameters.
contract AgentTreasury is TreasuryGate {
    constructor(
        WritRegistry registry_,
        address agent_,
        bytes32 allowedModelHash,
        address allowedProvider,
        uint8 maxRisk
    )
        TreasuryGate(
            registry_,
            agent_,
            Policy({
                promptHead: bytes(
                    '{"model":"0GM-1.0-35B-A3B","temperature":0,"messages":[{"role":"system","content":"You are a treasury risk gate. Reply with exactly ALLOW:<0-100> or DENY:<0-100> and nothing else."},{"role":"user","content":"Approve this transfer? '
                ),
                promptTail: bytes('"}]}'),
                allowedModelHash: allowedModelHash,
                allowedProvider: allowedProvider,
                maxRisk: maxRisk
            })
        )
    {}
}
