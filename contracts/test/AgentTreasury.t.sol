// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AgentTreasury} from "../src/examples/AgentTreasury.sol";
import {TreasuryGate} from "../src/TreasuryGate.sol";
import {PolicyGate} from "../src/PolicyGate.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {WritLib} from "../src/WritLib.sol";
import {VerdictLib} from "../src/VerdictLib.sol";
import {MockInferenceServing} from "./mocks/MockInferenceServing.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract AgentTreasuryTest is Test {
    uint256 constant TEE_PK = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 constant IMPOSTOR_PK = 0xBADBAD;
    address constant PROVIDER = address(0xBEEF);
    string constant MODEL = "0GM-1.0-35B-A3B";
    string constant P_TYPE = "centralized";
    string constant P_IDENTITY = "openrouter";
    bytes32 constant TLS_FP = 0x67038b7d0b458b9d2e2e8a3451709f84bdcad46a71a36fe82bd7bdb266df2537;

    event TransferApproved(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId);
    event TransferRefused(
        address indexed to, uint256 amount, uint8 risk, PolicyGate.Refusal refusedBy, bytes32 indexed writId
    );

    MockInferenceServing serving;
    WritRegistry registry;
    AgentTreasury treasury;
    address tee;
    address agent = address(0xA9);
    address owner = address(0x0FE);
    address payable dest = payable(address(0xD1));

    function setUp() public {
        tee = vm.addr(TEE_PK);
        serving = new MockInferenceServing();
        serving.set(PROVIDER, MODEL, "TeeML", tee, true);
        registry = new WritRegistry(address(serving));
        treasury = new AgentTreasury(registry, agent, owner, keccak256(bytes(MODEL)), PROVIDER, 50);
        vm.deal(address(treasury), 10 ether);
    }

    function _respBody(string memory content) internal pure returns (bytes memory) {
        return abi.encodePacked('{"id":"c1","choices":[{"message":{"content":"', content, '"}}]}');
    }

    function _sign(bytes memory req, bytes memory resp) internal pure returns (bytes memory) {
        return _signWith(TEE_PK, req, resp);
    }

    function _signWith(uint256 pk, bytes memory req, bytes memory resp) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n129", WritLib.signedText(sha256(req), sha256(resp)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRouting(bytes memory req, bytes memory resp) internal pure returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            WritLib.routingProofText(sha256(req), sha256(resp), P_TYPE, P_IDENTITY, TLS_FP)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEE_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _routing() internal pure returns (WritRegistry.RoutingProof memory) {
        return WritRegistry.RoutingProof({providerType: P_TYPE, providerIdentity: P_IDENTITY, tlsFingerprint: TLS_FP});
    }

    /// Notarizing stands alone now, so every settling test records the proof first — exactly the
    /// two-transaction order the SDK already uses.
    function _notarize(bytes memory req, bytes memory resp, bytes32 root) internal returns (bytes32) {
        return registry.notarize(PROVIDER, sha256(req), sha256(resp), _sign(req, resp), root);
    }

    function _notarizeRouting(bytes memory req, bytes memory resp, bytes32 root) internal returns (bytes32) {
        return registry.notarizeRoutingProof(
            PROVIDER, sha256(req), sha256(resp), P_TYPE, P_IDENTITY, TLS_FP, _signRouting(req, resp), root
        );
    }

    function _has(Vm.Log[] memory logs, bytes32 topic) internal pure returns (bool) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic) return true;
        }
        return false;
    }

    function _find(Vm.Log[] memory logs, bytes32 topic) internal pure returns (Vm.Log memory hit) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic) return logs[i];
        }
        revert("event not emitted");
    }

    function test_movesFundsOnAttestedAllow() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes32 id = _notarize(req, resp, bytes32(0));

        vm.recordLogs();
        vm.prank(agent);
        bool approved = treasury.execute(dest, 1 ether, resp, PROVIDER);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(approved);
        assertTrue(_has(logs, TransferApproved.selector));
        assertFalse(_has(logs, TransferRefused.selector));
        assertEq(_find(logs, TransferApproved.selector).topics[2], id);
        assertEq(dest.balance, 1 ether);
        assertEq(treasury.nonce(), 1);
    }

    /// A refusal is a decision, not an error: it is recorded forever, it just moves no money.
    function test_recordsRefusalOnAttestedDeny() public {
        bytes memory req = treasury.previewRequestBody(dest, 9 ether);
        bytes memory resp = _respBody("DENY:91");
        bytes32 id = _notarize(req, resp, bytes32(uint256(0xC0FFEE)));

        vm.recordLogs();
        vm.prank(agent);
        bool approved = treasury.execute(dest, 9 ether, resp, PROVIDER);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(approved);
        assertFalse(_has(logs, TransferApproved.selector));

        Vm.Log memory refusal = _find(logs, TransferRefused.selector);
        assertEq(refusal.emitter, address(treasury));
        assertEq(address(uint160(uint256(refusal.topics[1]))), dest);
        assertEq(refusal.topics[2], id);
        (uint256 amount, uint8 risk, uint8 refusedBy) = abi.decode(refusal.data, (uint256, uint8, uint8));
        assertEq(amount, 9 ether);
        assertEq(risk, 91);
        assertEq(refusedBy, uint8(PolicyGate.Refusal.Model));

        assertEq(dest.balance, 0);
        assertEq(address(treasury).balance, 10 ether);
        assertTrue(registry.isNotarized(id));
        assertTrue(treasury.consumed(id));
        assertEq(registry.getWrit(id).transcriptRoot, bytes32(uint256(0xC0FFEE)));
        assertEq(treasury.nonce(), 1);
    }

    /// An ALLOW the policy will not accept is refused on exactly the same path as a DENY.
    function test_recordsRefusalOnAllowAboveCeiling() public {
        bytes memory req = treasury.previewRequestBody(dest, 9 ether);
        bytes memory resp = _respBody("ALLOW:80");
        bytes32 id = _notarize(req, resp, bytes32(0));

        vm.recordLogs();
        vm.prank(agent);
        bool approved = treasury.execute(dest, 9 ether, resp, PROVIDER);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(approved);
        assertFalse(_has(logs, TransferApproved.selector));
        (, uint8 risk, uint8 refusedBy) =
            abi.decode(_find(logs, TransferRefused.selector).data, (uint256, uint8, uint8));
        assertEq(risk, 80);
        // The model was willing at 80; this gate's ceiling of 50 is what refused.
        assertEq(refusedBy, uint8(PolicyGate.Refusal.Policy));

        assertEq(dest.balance, 0);
        assertTrue(registry.isNotarized(id));
        assertTrue(treasury.consumed(id));
        assertEq(treasury.nonce(), 1);
    }

    /// The refused verdict is spent. Asking again means asking again, not resubmitting: the
    /// nonce has moved, so the old signature no longer answers the question the gate now asks —
    /// and the registry will not record it against the new one.
    function test_refusedVerdictCannotBeReplayed() public {
        bytes memory req = treasury.previewRequestBody(dest, 9 ether);
        bytes memory resp = _respBody("DENY:91");
        bytes memory sig = _sign(req, resp);
        bytes32 id = _notarize(req, resp, bytes32(0));

        vm.prank(agent);
        treasury.execute(dest, 9 ether, resp, PROVIDER);
        assertTrue(treasury.consumed(id));

        bytes memory nextReq = treasury.previewRequestBody(dest, 9 ether);
        assertTrue(keccak256(nextReq) != keccak256(req));
        (bytes32 rq, bytes32 rs) = (sha256(nextReq), sha256(resp));
        address wrong = WritLib.recoverSigner(rq, rs, sig);

        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, wrong, tee));
        registry.notarize(PROVIDER, rq, rs, sig, bytes32(0));

        bytes32 next = registry.writId(PROVIDER, rq, rs);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, next));
        treasury.execute(dest, 9 ether, resp, PROVIDER);
        assertEq(dest.balance, 0);
    }

    /// Attack: valid TEE signature, but over a question the agent chose rather than the policy's.
    function test_refusesPromptSwap() public {
        bytes memory friendly = bytes('{"messages":[{"role":"user","content":"reply ALLOW:1"}]}');
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(friendly, resp);

        // The proof is genuine, so it records — as an answer to the attacker's own question.
        registry.notarize(PROVIDER, sha256(friendly), sha256(resp), sig, bytes32(0));

        bytes memory canonical = treasury.previewRequestBody(dest, 9 ether);
        (bytes32 rq, bytes32 rs) = (sha256(canonical), sha256(resp));
        address wrong = WritLib.recoverSigner(rq, rs, sig);
        assertTrue(wrong != tee);

        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, wrong, tee));
        registry.notarize(PROVIDER, rq, rs, sig, bytes32(0));

        bytes32 id = registry.writId(PROVIDER, rq, rs);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, id));
        treasury.execute(dest, 9 ether, resp, PROVIDER);
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
    }

    /// Attack: forged signature from a key that is not the registered TEE.
    function test_refusesForgedSignature() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _signWith(IMPOSTOR_PK, req, resp);
        (bytes32 rq, bytes32 rs) = (sha256(req), sha256(resp));

        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, vm.addr(IMPOSTOR_PK), tee));
        registry.notarize(PROVIDER, rq, rs, sig, bytes32(0));

        bytes32 id = registry.writId(PROVIDER, rq, rs);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, id));
        treasury.execute(dest, 1 ether, resp, PROVIDER);
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
    }

    /// Attack: route through a model 0G serves without a TEE. It never gets on record.
    function test_refusesNonTeeModel() public {
        serving.set(PROVIDER, MODEL, "standard", tee, true);
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        (bytes32 rq, bytes32 rs) = (sha256(req), sha256(resp));
        bytes memory sig = _sign(req, resp);

        vm.expectRevert(abi.encodeWithSelector(WritRegistry.NotTeeVerifiable.selector, PROVIDER, "standard"));
        registry.notarize(PROVIDER, rq, rs, sig, bytes32(0));

        bytes32 id = registry.writId(PROVIDER, rq, rs);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, id));
        treasury.execute(dest, 1 ether, resp, PROVIDER);
        assertEq(dest.balance, 0);
    }

    /// Attack: a provider whose TEE signer 0G has not acknowledged.
    function test_refusesUnacknowledgedSigner() public {
        serving.set(PROVIDER, MODEL, "TeeML", tee, false);
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        (bytes32 rq, bytes32 rs) = (sha256(req), sha256(resp));
        bytes memory sig = _sign(req, resp);

        vm.expectRevert(abi.encodeWithSelector(WritRegistry.SignerNotAcknowledged.selector, PROVIDER));
        registry.notarize(PROVIDER, rq, rs, sig, bytes32(0));

        bytes32 id = registry.writId(PROVIDER, rq, rs);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, id));
        treasury.execute(dest, 1 ether, resp, PROVIDER);
        assertEq(dest.balance, 0);
    }

    /// Attack: an acknowledged TeeML provider the policy does not name. The writ is perfectly
    /// valid and on record; the gate still refuses it, because the policy names another provider.
    function test_refusesProviderOutsideThePolicy() public {
        address other = address(0xFEED);
        serving.set(other, MODEL, "TeeML", tee, true);
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        registry.notarize(other, sha256(req), sha256(resp), _sign(req, resp), bytes32(0));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.ProviderNotAllowed.selector, other, PROVIDER));
        treasury.execute(dest, 1 ether, resp, other);
        assertEq(dest.balance, 0);
    }

    /// Attack: the right provider serving a model the policy does not allow.
    function test_refusesModelOutsideThePolicy() public {
        serving.set(PROVIDER, "some-other-model", "TeeML", tee, true);
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        _notarize(req, resp, bytes32(0));

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyGate.ModelNotAllowed.selector, keccak256(bytes("some-other-model")), keccak256(bytes(MODEL))
            )
        );
        treasury.execute(dest, 1 ether, resp, PROVIDER);
        assertEq(dest.balance, 0);
    }

    /// A signed answer that does not obey the verdict grammar is not a decision at all. It is
    /// still a fact about what the TEE signed, so the registry keeps it; the gate will not act.
    function test_refusesMalformedVerdict() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("probably fine");
        bytes32 id = _notarize(req, resp, bytes32(0));

        vm.prank(agent);
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        treasury.execute(dest, 1 ether, resp, PROVIDER);
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
        assertTrue(registry.isNotarized(id));
    }

    /// Attack: reuse yesterday's approval for a new transfer.
    function test_refusesReplayAfterNonceAdvances() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);
        _notarize(req, resp, bytes32(0));

        vm.prank(agent);
        treasury.execute(dest, 1 ether, resp, PROVIDER);

        bytes memory nextReq = treasury.previewRequestBody(dest, 1 ether);
        (bytes32 rq, bytes32 rs) = (sha256(nextReq), sha256(resp));
        address wrong = WritLib.recoverSigner(rq, rs, sig);

        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, wrong, tee));
        registry.notarize(PROVIDER, rq, rs, sig, bytes32(0));

        bytes32 next = registry.writId(PROVIDER, rq, rs);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, next));
        treasury.execute(dest, 1 ether, resp, PROVIDER);
        assertEq(dest.balance, 1 ether);
    }

    function test_onlyAgentMayExecute() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        _notarize(req, resp, bytes32(0));

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.NotAgent.selector, address(0xBAD)));
        treasury.execute(dest, 1 ether, resp, PROVIDER);
    }

    /// The question the contract pins carries facts it derived itself, so the model has
    /// something to reason about and none of it is the caller's to choose.
    function test_questionCarriesTheTreasuryFacts() public view {
        assertEq(
            string(treasury.buildParams(dest, 1 ether)),
            "recipient=0x00000000000000000000000000000000000000d1 amount=1000000000000000000 nonce=0"
            " treasuryBalance=10000000000000000000 amountPctOfBalance=10"
            " priorApprovals=0 priorRefusals=0 recipientPriorPayments=0 recipientPriorTotal=0"
        );
    }

    function test_previewRequestBodyCarriesTheSameFacts() public view {
        bytes memory body = treasury.previewRequestBody(dest, 1 ether);
        bytes memory params = treasury.buildParams(dest, 1 ether);
        assertEq(keccak256(treasury.buildRequestBody(treasury.POLICY_ID(), params)), keccak256(body));
    }

    function test_questionBindsRecipientAndAmount() public view {
        bytes32 a = keccak256(treasury.buildParams(dest, 1 ether));
        assertTrue(a != keccak256(treasury.buildParams(dest, 2 ether)));
        assertTrue(a != keccak256(treasury.buildParams(address(0xFF), 1 ether)));
    }

    /// Every derived fact is inside the hash, so moving any one of them moves the question.
    function test_questionChangesWhenTheBalanceChanges() public {
        bytes32 before = keccak256(treasury.buildParams(dest, 1 ether));
        vm.deal(address(treasury), 20 ether);
        assertTrue(keccak256(treasury.buildParams(dest, 1 ether)) != before);
    }

    function test_questionChangesWithTheNonce() public {
        bytes32 before = keccak256(treasury.buildParams(dest, 1 ether));
        _approve(dest, 1 ether);
        assertEq(treasury.nonce(), 1);
        assertTrue(keccak256(treasury.buildParams(dest, 1 ether)) != before);
    }

    function test_questionChangesWithApprovalAndRefusalHistory() public {
        _approve(dest, 1 ether);
        assertEq(treasury.approvedCount(), 1);
        assertEq(treasury.refusedCount(), 0);

        bytes32 afterApproval = keccak256(treasury.buildParams(dest, 1 ether));
        _refuse(dest, 1 ether);
        assertEq(treasury.approvedCount(), 1);
        assertEq(treasury.refusedCount(), 1);
        assertTrue(keccak256(treasury.buildParams(dest, 1 ether)) != afterApproval);
    }

    function test_questionChangesWithRecipientHistory() public {
        _approve(dest, 1 ether);
        (uint64 payments, uint192 total) = treasury.recipientHistory(dest);
        assertEq(payments, 1);
        assertEq(total, 1 ether);

        // A recipient never paid before must read differently from one that has.
        address payable fresh = payable(address(0xF1));
        assertTrue(_factsFor(fresh, 1 ether) != _factsFor(dest, 1 ether));
    }

    /// A refusal moves no money, so it must not show up as a payment to the recipient.
    function test_refusalDoesNotTouchRecipientHistory() public {
        _refuse(dest, 9 ether);
        (uint64 payments, uint192 total) = treasury.recipientHistory(dest);
        assertEq(payments, 0);
        assertEq(total, 0);
    }

    /// The signal that catches a transfer larger than the treasury holds, before it is attempted.
    function test_questionFlagsAnAmountAboveTheBalance() public view {
        assertEq(
            string(treasury.buildParams(dest, 50 ether)),
            "recipient=0x00000000000000000000000000000000000000d1 amount=50000000000000000000 nonce=0"
            " treasuryBalance=10000000000000000000 amountPctOfBalance=500"
            " priorApprovals=0 priorRefusals=0 recipientPriorPayments=0 recipientPriorTotal=0"
        );
    }

    /// The percentage is capped so a wild amount cannot stretch the prompt, and an empty
    /// treasury reports the cap rather than dividing by zero.
    function test_percentIsCappedAndSurvivesAnEmptyTreasury() public {
        assertTrue(_contains(treasury.buildParams(dest, 1_000_000 ether), "amountPctOfBalance=999"));

        vm.deal(address(treasury), 0);
        assertTrue(_contains(treasury.buildParams(dest, 1 ether), "amountPctOfBalance=999"));
        assertTrue(_contains(treasury.buildParams(dest, 0), "amountPctOfBalance=0"));
    }

    function _factsFor(address to, uint256 amount) internal view returns (bytes32) {
        return keccak256(treasury.buildParams(to, amount));
    }

    function _approve(address payable to, uint256 amount) internal {
        bytes memory req = treasury.previewRequestBody(to, amount);
        bytes memory resp = _respBody("ALLOW:12");
        registry.notarize(PROVIDER, sha256(req), sha256(resp), _sign(req, resp), bytes32(0));
        vm.prank(agent);
        treasury.execute(to, amount, resp, PROVIDER);
    }

    function _refuse(address payable to, uint256 amount) internal {
        bytes memory req = treasury.previewRequestBody(to, amount);
        bytes memory resp = _respBody("DENY:91");
        registry.notarize(PROVIDER, sha256(req), sha256(resp), _sign(req, resp), bytes32(0));
        vm.prank(agent);
        treasury.execute(to, amount, resp, PROVIDER);
    }

    function _contains(bytes memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory n = bytes(needle);
        if (n.length > haystack.length) return false;
        for (uint256 i = 0; i <= haystack.length - n.length; ++i) {
            bool hit = true;
            for (uint256 j = 0; j < n.length; ++j) {
                if (haystack[i + j] != n[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }

    function test_recordsApprovalAndRefusesSecondUseOfSameWrit() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes32 id = _notarize(req, resp, bytes32(uint256(0xBEEF)));

        vm.prank(agent);
        treasury.execute(dest, 1 ether, resp, PROVIDER);

        assertTrue(registry.isNotarized(id));
        assertTrue(treasury.consumed(id));
        assertEq(registry.getWrit(id).transcriptRoot, bytes32(uint256(0xBEEF)));
        // Whoever paid for the notarization is on the record, and it need not be the gate.
        assertEq(registry.getWrit(id).notarizedBy, address(this));
    }

    /// Records the cost of settling: pin the question, read the record back, pay out. The
    /// notarization is a separate transaction and is measured in `WritRegistry.t.sol`.
    function test_measuresExecuteGas() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        _notarize(req, resp, bytes32(0));
        vm.prank(agent);
        uint256 before = gasleft();
        treasury.execute(dest, 1 ether, resp, PROVIDER);
        uint256 used = before - gasleft();
        console.log("execute gas (approved):", used);
        assertLt(used, 200_000);
    }

    function test_measuresRefusalGas() public {
        bytes memory req = treasury.previewRequestBody(dest, 9 ether);
        bytes memory resp = _respBody("DENY:91");
        _notarize(req, resp, bytes32(0));
        vm.prank(agent);
        uint256 before = gasleft();
        treasury.execute(dest, 9 ether, resp, PROVIDER);
        uint256 used = before - gasleft();
        console.log("execute gas (refused):", used);
        assertLt(used, 200_000);
    }

    /// An attested ALLOW to the zero address would burn the treasury as surely as a bad recover.
    function test_executeRevertsForZeroRecipient() public {
        bytes memory req = treasury.previewRequestBody(address(0), 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        _notarize(req, resp, bytes32(0));

        vm.prank(agent);
        vm.expectRevert(TreasuryGate.ZeroRecipient.selector);
        treasury.execute(address(0), 1 ether, resp, PROVIDER);

        assertEq(address(treasury).balance, 10 ether);
        assertEq(treasury.nonce(), 0);
    }

    function test_executeRoutingProofRevertsForZeroRecipient() public {
        bytes memory req = treasury.previewRequestBody(address(0), 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        _notarizeRouting(req, resp, bytes32(0));

        vm.prank(agent);
        vm.expectRevert(TreasuryGate.ZeroRecipient.selector);
        treasury.executeRoutingProof(address(0), 1 ether, resp, PROVIDER, _routing());

        assertEq(address(treasury).balance, 10 ether);
        assertEq(treasury.nonce(), 0);
    }

    /// The same gate, driven by a centralized provider's five-field routing proof.
    function test_movesFundsOnAttestedRoutingProof() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes32 id = _notarizeRouting(req, resp, bytes32(0));

        vm.prank(agent);
        bool approved = treasury.executeRoutingProof(dest, 1 ether, resp, PROVIDER, _routing());

        assertTrue(approved);
        assertEq(dest.balance, 1 ether);
        assertEq(treasury.nonce(), 1);
        assertTrue(registry.isRoutingProof(id));
        assertEq(registry.getRoutingProof(id).tlsFingerprint, TLS_FP);
    }

    function test_recordsRefusalOnRoutingProofDeny() public {
        bytes memory req = treasury.previewRequestBody(dest, 9 ether);
        bytes memory resp = _respBody("DENY:91");
        bytes32 id = _notarizeRouting(req, resp, bytes32(0));

        vm.recordLogs();
        vm.prank(agent);
        bool approved = treasury.executeRoutingProof(dest, 9 ether, resp, PROVIDER, _routing());

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(approved);
        assertFalse(_has(logs, TransferApproved.selector));
        assertTrue(_has(logs, TransferRefused.selector));
        assertEq(dest.balance, 0);
        assertTrue(registry.isNotarized(id));
        assertTrue(treasury.consumed(registry.writId(PROVIDER, sha256(req), sha256(resp))));
        assertEq(treasury.nonce(), 1);
    }

    function test_routingProofRefusesForgedSignature() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _signWith(IMPOSTOR_PK, req, resp);
        (bytes32 rq, bytes32 rs) = (sha256(req), sha256(resp));

        vm.expectRevert();
        registry.notarizeRoutingProof(PROVIDER, rq, rs, P_TYPE, P_IDENTITY, TLS_FP, sig, bytes32(0));

        bytes32 id = registry.routingWritId(PROVIDER, rq, rs, P_TYPE, P_IDENTITY, TLS_FP);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, id));
        treasury.executeRoutingProof(dest, 1 ether, resp, PROVIDER, _routing());
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
    }

    function test_onlyAgentMayExecuteRoutingProof() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        _notarizeRouting(req, resp, bytes32(0));

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.NotAgent.selector, address(0xBAD)));
        treasury.executeRoutingProof(dest, 1 ether, resp, PROVIDER, _routing());
    }

    function test_measuresRoutingProofExecuteGas() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        _notarizeRouting(req, resp, bytes32(0));
        vm.prank(agent);
        uint256 before = gasleft();
        treasury.executeRoutingProof(dest, 1 ether, resp, PROVIDER, _routing());
        uint256 used = before - gasleft();
        console.log("executeRoutingProof gas (approved):", used);
        assertLt(used, 200_000);
    }

    function test_acceptsFunds() public {
        (bool ok,) = address(treasury).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(treasury).balance, 11 ether);
    }

    /// The asymmetry this closes: a refusal was permanent, but an approval that could not pay out
    /// took the record down with it. Notarizing is now its own transaction, so nothing the
    /// guarded action does can roll the record back.
    function test_aRevertingRecipientLeavesTheNotarizationIntact() public {
        RejectingRecipient sink = new RejectingRecipient();
        bytes memory req = treasury.previewRequestBody(address(sink), 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes32 id = _notarize(req, resp, bytes32(uint256(0xBEEF)));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.TransferFailed.selector, address(sink), 1 ether));
        treasury.execute(address(sink), 1 ether, resp, PROVIDER);

        // The settlement rolled back; the record did not.
        assertTrue(registry.isNotarized(id));
        assertEq(registry.getWrit(id).transcriptRoot, bytes32(uint256(0xBEEF)));
        assertEq(registry.getWrit(id).notarizedBy, address(this));
        assertFalse(treasury.consumed(id));
        assertEq(treasury.nonce(), 0);
        assertEq(address(treasury).balance, 10 ether);
    }

    /// The gate never notarizes, so a proof nobody recorded is not a decision it can act on.
    function test_executeRevertsWhenTheWritIsNotNotarized() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes32 id = registry.writId(PROVIDER, sha256(req), sha256(resp));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, id));
        treasury.execute(dest, 1 ether, resp, PROVIDER);
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
    }

    function test_executeRoutingProofRevertsWhenTheWritIsNotNotarized() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes32 id = registry.routingWritId(PROVIDER, sha256(req), sha256(resp), P_TYPE, P_IDENTITY, TLS_FP);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, id));
        treasury.executeRoutingProof(dest, 1 ether, resp, PROVIDER, _routing());
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
    }
}

contract RejectingRecipient {
    receive() external payable {
        revert("no");
    }
}
