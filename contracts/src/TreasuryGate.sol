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
///      only after `RECOVERY_DELAY` without a decision. Without it a provider that stops serving
///      signatures would brick the treasury permanently. See `lastAttestationAt` for exactly what
///      that delay measures — it is narrower than it sounds.
contract TreasuryGate is PolicyGate, ReentrancyGuard {
    uint256 public constant POLICY_ID = 1;

    /// @notice How long this gate must go without a decision before the owner may sweep it.
    /// @dev Thirty days. Deliberately long: the hatch is a last resort for a treasury that would
    ///      otherwise be stuck forever, not a routine withdrawal path.
    uint64 public constant RECOVERY_DELAY = 30 days;

    address public immutable agent;

    /// @notice Holds the recovery key. Deliberately not the agent: the agent must never be able
    ///         to take the escape hatch it can also trigger by simply not asking for verdicts.
    address public immutable owner;

    uint256 public nonce;

    /// @notice When this gate last saw a verifiable proof, approval or refusal alike.
    /// @dev Seeded at deployment so the escape hatch is not open the moment the gate exists.
    ///
    ///      Be precise about what this measures, because the name invites a stronger reading than
    ///      it deserves. It is a timer on **this gate's inactivity**, not on the provider's
    ///      liveness. The gate only learns that a provider is alive when the agent brings it a
    ///      proof, so provider liveness is observed through the agent and cannot be separated
    ///      from it. Three consequences follow, all of them intended:
    ///
    ///      1. An agent that keeps producing decisions postpones recovery indefinitely. Refusals
    ///         count, because a refusal is as much evidence of a working provider as an approval
    ///         is. So an agent that never approves anything but keeps paying gas for a refusal
    ///         every few weeks can hold the treasury away from the owner for as long as it likes.
    ///      2. An agent that simply stops asking hands the owner a sweep after `RECOVERY_DELAY`,
    ///         even if the provider was healthy the whole time. From the gate's point of view a
    ///         silent provider and an idle agent are the same event.
    ///      3. Neither case is reachable by an outsider. The owner appoints the agent, so this is
    ///         a trust assumption between those two parties rather than a vulnerability: whoever
    ///         you appoint agent, you are trusting not to sit on the hatch.
    ///
    ///      The mechanism is what it is on purpose. Measuring provider liveness directly would
    ///      mean trusting something other than a signature the provider actually produced, which
    ///      is the one thing this contract refuses to do anywhere else.
    uint64 public lastAttestationAt;

    error NotAgent(address caller);
    error NotOwner(address caller);
    error RecoveryNotYetAvailable(uint64 availableAt);
    error ZeroRecipient();
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

        return _settle(to, amount, id, approved, risk);
    }

    /// @notice `execute` against a centralized provider's routing proof.
    /// @dev Most live 0G mainnet providers are centralized, so this is the path that reaches
    ///      them. It also binds more: the proof names the upstream that actually answered.
    /// @return approved Whether the funds moved.
    function executeRoutingProof(
        address to,
        uint256 amount,
        bytes calldata rawResponse,
        address provider,
        WritRegistry.RoutingProof calldata routing,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) external nonReentrant returns (bool approved) {
        if (msg.sender != agent) revert NotAgent(msg.sender);

        bytes memory params = buildParams(to, amount, nonce);
        uint8 risk;
        bytes32 id;
        (id, approved, risk) =
            _consumeRoutingProof(POLICY_ID, params, rawResponse, provider, routing, signature, transcriptRoot);

        return _settle(to, amount, id, approved, risk);
    }

    /// @dev Reached only once a proof has verified, so both proof kinds settle identically.
    function _settle(address to, uint256 amount, bytes32 id, bool approved, uint8 risk) private returns (bool) {
        // A verified proof is what the recovery clock measures. A refusal counts: it is just as
        // much evidence that the provider is still signing.
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
        return true;
    }

    /// @notice The timestamp from which `recover` becomes callable.
    function recoveryAvailableAt() public view returns (uint64) {
        return lastAttestationAt + RECOVERY_DELAY;
    }

    /// @notice Sweep the treasury after this gate has gone `RECOVERY_DELAY` without a decision.
    /// @dev Bounded escape hatch, not an admin override: any verified proof, approval or
    ///      refusal, pushes the deadline back out of reach.
    ///
    ///      Read `lastAttestationAt` for what the delay does and does not measure. In short: this
    ///      is a timer on the gate, so it protects the owner against a dead provider and against
    ///      an agent that has stopped working, but it does not protect the owner against an agent
    ///      that keeps working and simply never approves anything.
    ///
    ///      The recipient is the owner's to choose, so the only check here is that it is not the
    ///      zero address — sweeping there would burn the treasury this function exists to rescue.
    function recover(address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        if (to == address(0)) revert ZeroRecipient();

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
