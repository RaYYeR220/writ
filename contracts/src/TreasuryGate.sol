// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyGate} from "./PolicyGate.sol";
import {WritRegistry} from "./WritRegistry.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
    /// @notice What this gate has already paid a given recipient.
    /// @dev Packed into one slot: both fields are facts the pinned question reports, so recording
    ///      a payment should cost one write rather than two.
    struct RecipientHistory {
        uint64 payments;
        uint192 total;
    }

    uint256 public constant POLICY_ID = 1;

    /// @dev Ceiling on the reported percentage, so an absurd amount cannot stretch the prompt.
    uint256 private constant PCT_CAP = 999;

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

    /// @notice How many transfers this gate has approved, and how many it has refused.
    /// @dev Both are facts the pinned question reports. Declared next to `lastAttestationAt` so
    ///      the three share one slot and settling a decision still writes a single slot.
    uint96 public approvedCount;
    uint96 public refusedCount;

    /// @notice What this gate has paid each recipient so far.
    /// @dev Updated only when funds actually move, so a refusal never reads as a payment.
    mapping(address => RecipientHistory) public recipientHistory;

    error NotAgent(address caller);
    error NotOwner(address caller);
    error RecoveryNotYetAvailable(uint64 availableAt);
    error ZeroRecipient();
    error TransferFailed(address to, uint256 amount);

    event TransferApproved(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId);
    /// @dev `refusedBy` separates the model declining from this gate's ceiling declining an
    ///      answer the model was willing to give. Both mean no funds moved.
    event TransferRefused(address indexed to, uint256 amount, uint8 risk, Refusal refusedBy, bytes32 indexed writId);
    event Recovered(address indexed to, uint256 amount, uint64 lastAttestationAt);

    constructor(WritRegistry registry_, address agent_, address owner_, Policy memory policy) PolicyGate(registry_) {
        agent = agent_;
        owner = owner_;
        lastAttestationAt = uint64(block.timestamp);
        _setPolicy(POLICY_ID, policy);
    }

    receive() external payable {}

    /// @notice The facts this contract pins into the question it asks about a transfer.
    /// @dev Built only from typed values, so no caller-supplied text reaches the question, and
    ///      only from this contract's own state and the action proposed — the recipient and the
    ///      amount are the action itself; everything else the contract derives here and now. That
    ///      is what the prompt-swap defence rests on: `execute` rebuilds this exact string, and a
    ///      proof satisfies the gate only if the TEE signed the question containing it. A caller
    ///      cannot understate the balance, hide a refusal history, or claim a recipient is a
    ///      familiar one.
    ///
    ///      THE CONSEQUENCE, PLAINLY: because the treasury's live state is inside the question, an
    ///      attestation is bound to the state at the moment the question was built. If the balance
    ///      moves, another transfer settles, or this recipient is paid again before the proof is
    ///      submitted, the question is no longer the same question and the old proof does not
    ///      answer it. `execute` will revert rather than accept it, and the answer has to be
    ///      obtained again. This is the discipline the nonce already imposes per action, widened
    ///      to the treasury as a whole; it is a deliberate trade of convenience for the guarantee
    ///      that the model judged the treasury as it actually stood.
    ///
    ///      Amounts are in wei. `amountPctOfBalance` is the amount as a percentage of the balance
    ///      *before* the transfer, so a value over 100 means the treasury cannot cover it.
    function buildParams(address to, uint256 amount) public view virtual returns (bytes memory) {
        // Split in two only because one `encodePacked` over all nine fields is stack-too-deep.
        return bytes.concat(_proposedTransfer(to, amount), _treasuryHistory(to));
    }

    /// @dev What is being asked, and how big it is relative to what the treasury holds.
    function _proposedTransfer(address to, uint256 amount) private view returns (bytes memory) {
        uint256 bal = address(this).balance;
        return abi.encodePacked(
            "recipient=",
            Strings.toHexString(to),
            " amount=",
            Strings.toString(amount),
            " nonce=",
            Strings.toString(nonce),
            " treasuryBalance=",
            Strings.toString(bal),
            " amountPctOfBalance=",
            Strings.toString(_percentOfBalance(amount, bal))
        );
    }

    /// @dev What this treasury has done before, in general and with this recipient.
    function _treasuryHistory(address to) private view returns (bytes memory) {
        RecipientHistory memory h = recipientHistory[to];
        return abi.encodePacked(
            " priorApprovals=",
            Strings.toString(approvedCount),
            " priorRefusals=",
            Strings.toString(refusedCount),
            " recipientPriorPayments=",
            Strings.toString(h.payments),
            " recipientPriorTotal=",
            Strings.toString(h.total)
        );
    }

    /// @notice The exact bytes to post to the 0G Compute provider for the next transfer.
    /// @dev Post these bytes verbatim. They embed the treasury's state as of this call, so if the
    ///      treasury moves before you submit the proof, call this again and re-ask the model.
    function previewRequestBody(address to, uint256 amount) external view returns (bytes memory) {
        return buildRequestBody(POLICY_ID, buildParams(to, amount));
    }

    /// @dev The most useful number in the question: it turns two 18-decimal integers a model reads
    ///      badly into one small one it reads well. Total by construction — an empty treasury
    ///      reports the cap rather than dividing by zero, and `mulDiv` carries the 512-bit
    ///      intermediate so a large amount cannot overflow the multiplication.
    function _percentOfBalance(uint256 amount, uint256 bal) private pure returns (uint256) {
        if (amount == 0) return 0;
        if (bal == 0) return PCT_CAP;
        uint256 pct = Math.mulDiv(amount, 100, bal);
        return pct > PCT_CAP ? PCT_CAP : pct;
    }

    /// @dev Reached only when funds actually move.
    function _recordPayment(address to, uint256 amount) private {
        RecipientHistory storage h = recipientHistory[to];
        unchecked {
            // 2^64 payments out of one gate is not reachable.
            h.payments += 1;

            // Saturating rather than reverting. This is a fact for a prompt, not a ledger, and a
            // treasury that had somehow accumulated 192 bits of payments to one address should
            // not lose the transfer in front of it over an arithmetic edge.
            uint256 total = uint256(h.total) + amount;
            // forge-lint: disable-next-line(unsafe-typecast)
            h.total = (total < amount || total > type(uint192).max) ? type(uint192).max : uint192(total);
        }
    }

    /// @notice Move funds, but only against an attested ALLOW for this exact action.
    /// @dev The proof must already be in `WritRegistry`. Notarize it first, in its own
    ///      transaction — that is what keeps the record from sharing this transaction's fate. A
    ///      recipient that rejects the transfer reverts the payout and nothing else: the writ, and
    ///      the fact that this question was answered, stay on chain.
    ///
    ///      A verified refusal is not an error: it emits `TransferRefused`, spends the nonce and
    ///      returns false. Only a proof that does not satisfy the gate reverts.
    ///
    ///      The zero recipient is rejected before any of that. An attested ALLOW naming
    ///      `address(0)` would burn the treasury exactly as a bad `recover` would, and no verdict
    ///      should be able to authorise that, so the check sits ahead of the proof rather than
    ///      inside the settlement.
    /// @return approved Whether the funds moved.
    function execute(address to, uint256 amount, bytes calldata rawResponse, address provider)
        external
        nonReentrant
        returns (bool approved)
    {
        if (msg.sender != agent) revert NotAgent(msg.sender);
        if (to == address(0)) revert ZeroRecipient();

        bytes memory params = buildParams(to, amount);
        return _settle(to, amount, _consume(POLICY_ID, params, rawResponse, provider));
    }

    /// @notice `execute` against a centralized provider's routing proof.
    /// @dev Most live 0G mainnet providers are centralized, so this is the path that reaches
    ///      them. It also binds more: the proof names the upstream that actually answered. The
    ///      routing writ must already be notarized, exactly as on the chat path.
    /// @return approved Whether the funds moved.
    function executeRoutingProof(
        address to,
        uint256 amount,
        bytes calldata rawResponse,
        address provider,
        WritRegistry.RoutingProof calldata routing
    ) external nonReentrant returns (bool approved) {
        if (msg.sender != agent) revert NotAgent(msg.sender);
        if (to == address(0)) revert ZeroRecipient();

        bytes memory params = buildParams(to, amount);
        return _settle(to, amount, _consumeRoutingProof(POLICY_ID, params, rawResponse, provider, routing));
    }

    /// @dev Reached only once a proof has verified, so both proof kinds settle identically.
    ///      Approval is read off `refusedBy` rather than passed in beside it, so there is exactly
    ///      one place that decides whether the money moves.
    function _settle(address to, uint256 amount, Decision memory d) private returns (bool) {
        // A verified proof is what the recovery clock measures. A refusal counts: it is just as
        // much evidence that the provider is still signing.
        lastAttestationAt = uint64(block.timestamp);

        // A refused action must be re-asked, not retried against a stale question.
        unchecked {
            ++nonce;
        }

        if (d.refusedBy != Refusal.None) {
            unchecked {
                ++refusedCount;
            }
            emit TransferRefused(to, amount, d.risk, d.refusedBy, d.id);
            return false;
        }

        unchecked {
            ++approvedCount;
        }
        _recordPayment(to, amount);
        emit TransferApproved(to, amount, d.risk, d.id);

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
