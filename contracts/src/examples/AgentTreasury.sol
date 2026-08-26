// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreasuryGate} from "../TreasuryGate.sol";
import {WritRegistry} from "../WritRegistry.sol";

// The model `AgentTreasury`'s question names, spelled exactly as it appears inside `promptHead`.
// File-level so a deploy script can read it without an instance to read it from. The contract
// republishes it as `PROMPT_MODEL` for on-chain readers; both are this one value.
string constant AGENT_TREASURY_PROMPT_MODEL = "0GM-1.0-35B-A3B";

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
    /// @notice The model this treasury's question names, spelled exactly as it appears inside
    ///         `promptHead`.
    /// @dev Published so a deployer can check it against what 0G reports the chosen provider
    ///      serving. `allowedModelHash` is a constructor parameter and this string is not, so
    ///      the two can disagree — and a gate whose two halves disagree asks about one model and
    ///      accepts an answer from another. Nothing on chain can reconcile them after the fact;
    ///      the check belongs at deployment. See `script/Deploy.s.sol`.
    string public constant PROMPT_MODEL = AGENT_TREASURY_PROMPT_MODEL;

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
