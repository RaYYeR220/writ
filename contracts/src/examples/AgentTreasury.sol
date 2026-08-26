// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyGate} from "../PolicyGate.sol";
import {WritRegistry} from "../WritRegistry.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgentTreasury
/// @notice A treasury an autonomous agent operates but cannot drain.
/// @dev Funds move only against a TEE-attested ALLOW answering this contract's own question
///      about this exact recipient, amount, and nonce. Every decision is recorded forever.
contract AgentTreasury is PolicyGate, ReentrancyGuard {
    uint256 public constant POLICY_ID = 1;

    address public immutable agent;
    uint256 public nonce;

    error NotAgent(address caller);
    error TransferFailed(address to, uint256 amount);

    event TransferApproved(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId);

    constructor(
        WritRegistry registry_,
        address agent_,
        bytes32 allowedModelHash,
        address allowedProvider,
        uint8 maxRisk
    ) PolicyGate(registry_) {
        agent = agent_;
        _setPolicy(
            POLICY_ID,
            Policy({
                promptHead: bytes(
                    '{"model":"0GM-1.0-35B-A3B","temperature":0,"messages":[{"role":"system","content":"You are a treasury risk gate. Reply with exactly ALLOW:<0-100> or DENY:<0-100> and nothing else."},{"role":"user","content":"Approve this transfer? '
                ),
                promptTail: bytes('"}]}'),
                allowedModelHash: allowedModelHash,
                allowedProvider: allowedProvider,
                maxRisk: maxRisk
            })
        );
    }

    receive() external payable {}

    /// @dev Built only from typed values, so no caller-supplied text reaches the question.
    function buildParams(address to, uint256 amount, uint256 n) public pure returns (bytes memory) {
        return abi.encodePacked(
            "recipient=", Strings.toHexString(to), " amount=", Strings.toString(amount), " nonce=", Strings.toString(n)
        );
    }

    /// @notice The exact bytes to post to the 0G Compute provider for the next transfer.
    function previewRequestBody(address to, uint256 amount) external view returns (bytes memory) {
        return buildRequestBody(POLICY_ID, buildParams(to, amount, nonce));
    }

    /// @notice Move funds, but only against an attested ALLOW for this exact action.
    function execute(
        address to,
        uint256 amount,
        bytes calldata rawResponse,
        address provider,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) external nonReentrant {
        if (msg.sender != agent) revert NotAgent(msg.sender);

        bytes memory params = buildParams(to, amount, nonce);
        (bytes32 id, uint8 risk) = _consume(POLICY_ID, params, rawResponse, provider, signature, transcriptRoot);

        unchecked {
            ++nonce;
        }
        emit TransferApproved(to, amount, risk, id);

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }
}
