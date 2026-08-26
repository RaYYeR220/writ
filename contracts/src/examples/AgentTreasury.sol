// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PromptLib} from "../PromptLib.sol";
import {TreasuryGate} from "../TreasuryGate.sol";
import {WritRegistry} from "../WritRegistry.sol";

/// @title AgentTreasury
/// @notice The reference treasury gate: a ready-made policy an agent can be pointed at.
/// @dev Everything except the model, provider and risk ceiling is fixed here, so the question
///      the contract pins is visible in the source rather than in deployment parameters.
///
///      The model is a NAME, not a hash. This contract used to spell its model inside
///      `promptHead` and take `allowedModelHash` as a separate argument, which let the two halves
///      of the gate disagree — a treasury that asked about one model and accepted an answer from
///      another, with the mismatch catchable only at deploy time and never afterwards. It now
///      builds through `PromptLib` exactly as `PolicyGateFactory` does: one string is written
///      into the question and hashed for the policy, so there is nothing left to disagree.
///
///      The system half of the prompt exists to make the facts `TreasuryGate.buildParams` derives
///      legible to the model: without being told what `amountPctOfBalance` means, a model cannot
///      act on it. The answer grammar stays exactly `ALLOW:<0-100>` or `DENY:<0-100>`, because
///      `VerdictLib` accepts nothing else.
contract AgentTreasury is TreasuryGate {
    /// @dev This contract's half of the question, which begins where the model key ends. It goes
    ///      through the same `"model"`-key scan a factory caller's bytes do — these literals are
    ///      trusted, but a rule that skipped its own author is a rule with an exception in it.
    bytes private constant PROMPT_HEAD =
        '"temperature":0,"messages":[{"role":"system","content":"You are a treasury risk gate. You are given a proposed transfer and facts about the treasury as key=value pairs, all amounts in wei. amountPctOfBalance is the transfer as a percentage of the current balance, so over 100 means the treasury cannot cover it. recipientPriorPayments and recipientPriorTotal are what this treasury has already sent that address. Weigh the size of the transfer against the balance, how familiar the recipient is, and the recipient itself. Reply with exactly ALLOW:<0-100> or DENY:<0-100>, the number being your risk score, and nothing else."},{"role":"user","content":"Approve this transfer? ';

    bytes private constant PROMPT_TAIL = '"}]}';

    /// @param modelName The model this treasury asks, spelled as 0G reports the chosen provider
    ///        serving it. It is written into the question and hashed into `allowedModelHash` from
    ///        this one value, so a deployer picks the model once and cannot pick it twice.
    constructor(
        WritRegistry registry_,
        address agent_,
        address owner_,
        string memory modelName,
        address allowedProvider,
        uint8 maxRisk
    )
        TreasuryGate(
            registry_,
            agent_,
            owner_,
            Policy({
                promptHead: PromptLib.buildPromptHead(modelName, PROMPT_HEAD, PROMPT_TAIL),
                promptTail: PROMPT_TAIL,
                allowedModelHash: keccak256(bytes(modelName)),
                allowedProvider: allowedProvider,
                maxRisk: maxRisk
            })
        )
    {}
}
