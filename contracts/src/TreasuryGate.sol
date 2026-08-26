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
///
///      The one route out that does not need a verdict is `recover`, which the owner may take
///      only after `RECOVERY_DELAY` of provider silence. Without it a provider that stops
///      serving signatures would brick the treasury permanently.
contract TreasuryGate is PolicyGate, ReentrancyGuard {
    uint256 public constant POLICY_ID = 1;

    /// @notice How long the provider must go silent before the owner may sweep the treasury.
    uint64 public constant RECOVERY_DELAY = 30 days;

    address public immutable agent;

    /// @notice Holds the recovery key. Deliberately not the agent: the agent must never be able
    ///         to take the escape hatch it can also trigger by simply not asking for verdicts.
    address public immutable owner;

    uint256 public nonce;

    /// @notice When this gate last saw a verifiable proof, approval or refusal alike.
    /// @dev Seeded at deployment so the escape hatch is not open the moment the gate exists.
    uint64 public lastAttestationAt;

    error NotAgent(address caller);
    error NotOwner(address caller);
    error RecoveryNotYetAvailable(uint64 availableAt);
    error TransferFailed(address to, uint256 amount);

    event TransferApproved(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId);
    event TransferRefused(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId);
    event Recovered(address indexed to, uint256 amount, uint64 lastAttestationAt);

    constructor(WritRegistry registry_, address agent_, address owner_, Policy memory policy) PolicyGate(registry_) {
        agent = agent_;
        owner = owner_;
        lastAttestationAt = uint64(block.timestamp);
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

        // Reaching this line means the proof verified, which is what the recovery clock measures.
        // A refusal counts: it is just as much evidence that the provider is still signing.
        lastAttestationAt = uint64(block.timestamp);

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

    /// @notice The timestamp from which `recover` becomes callable.
    function recoveryAvailableAt() public view returns (uint64) {
        return lastAttestationAt + RECOVERY_DELAY;
    }

    /// @notice Sweep the treasury after the provider has gone silent for `RECOVERY_DELAY`.
    /// @dev Bounded escape hatch, not an admin override: any verified proof, approval or
    ///      refusal, pushes the deadline back out of reach.
    function recover(address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner(msg.sender);

        uint64 availableAt = recoveryAvailableAt();
        // a 30-day window dwarfs any timestamp drift a validator could induce
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= availableAt) revert RecoveryNotYetAvailable(availableAt);

        uint256 amount = address(this).balance;
        emit Recovered(to, amount, lastAttestationAt);

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }
}
