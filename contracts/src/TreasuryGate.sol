// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyGate} from "./PolicyGate.sol";
import {WritRegistry} from "./WritRegistry.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TreasuryGate
/// @notice A treasury an autonomous agent operates but cannot drain.
/// @dev Funds move only against a TEE-attested ALLOW answering this contract's own question
///      about this exact recipient, amount, and nonce. Every decision is recorded forever.
///      The policy is supplied at construction, so `PolicyGateFactory` can deploy a gate for
///      any prompt, model, provider and risk ceiling without new Solidity.
contract TreasuryGate is PolicyGate, ReentrancyGuard {
    uint256 public constant POLICY_ID = 1;

    address public immutable agent;
    uint256 public nonce;

    error NotAgent(address caller);
    error TransferFailed(address to, uint256 amount);

    event TransferApproved(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId);
    event TransferRefused(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId);

    constructor(WritRegistry registry_, address agent_, Policy memory policy) PolicyGate(registry_) {
        agent = agent_;
        _setPolicy(POLICY_ID, policy);
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
    /// @dev A verified refusal is not an error: it notarizes, emits `TransferRefused`, spends the
    ///      nonce and returns false. Only a verification failure reverts.
    /// @return approved Whether the funds moved.
    function execute(
        address to,
        uint256 amount,
        bytes calldata rawResponse,
        address provider,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) external nonReentrant returns (bool approved) {
        if (msg.sender != agent) revert NotAgent(msg.sender);

        bytes memory params = buildParams(to, amount, nonce);
        uint8 risk;
        bytes32 id;
        (id, approved, risk) = _consume(POLICY_ID, params, rawResponse, provider, signature, transcriptRoot);

        // A refused action must be re-asked, not retried against a stale question.
        unchecked {
            ++nonce;
        }

        if (!approved) {
            emit TransferRefused(to, amount, risk, id);
            return false;
        }

        emit TransferApproved(to, amount, risk, id);

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }
}
