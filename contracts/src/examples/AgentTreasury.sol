// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreasuryGate} from "../TreasuryGate.sol";
import {WritRegistry} from "../WritRegistry.sol";

/// @title AgentTreasury
/// @notice The reference treasury gate: a ready-made policy an agent can be pointed at.
/// @dev Everything except the model, provider and risk ceiling is fixed here, so the question
///      the contract pins is visible in the source rather than in deployment parameters.
///
///      The system half of the prompt exists to make the facts `TreasuryGate.buildParams` derives
///      legible to the model: without being told what `amountPctOfBalance` means, a model cannot
///      act on it. The answer grammar stays exactly `ALLOW:<0-100>` or `DENY:<0-100>`, because
///      `VerdictLib` accepts nothing else.
contract AgentTreasury is TreasuryGate {
    constructor(
        WritRegistry registry_,
        address agent_,
        address owner_,
        bytes32 allowedModelHash,
        address allowedProvider,
        uint8 maxRisk
    )
        TreasuryGate(
            registry_,
            agent_,
            owner_,
            Policy({
                promptHead: bytes(
                    '{"model":"0GM-1.0-35B-A3B","temperature":0,"messages":[{"role":"system","content":"You are a treasury risk gate. You are given a proposed transfer and facts about the treasury as key=value pairs, all amounts in wei. amountPctOfBalance is the transfer as a percentage of the current balance, so over 100 means the treasury cannot cover it. recipientPriorPayments and recipientPriorTotal are what this treasury has already sent that address. Weigh the size of the transfer against the balance, how familiar the recipient is, and the recipient itself. Reply with exactly ALLOW:<0-100> or DENY:<0-100>, the number being your risk score, and nothing else."},{"role":"user","content":"Approve this transfer? '
                ),
                promptTail: bytes('"}]}'),
                allowedModelHash: allowedModelHash,
                allowedProvider: allowedProvider,
                maxRisk: maxRisk
            })
        )
    {}
}
