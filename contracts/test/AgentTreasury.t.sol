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
    event TransferRefused(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId);

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
        bytes memory sig = _sign(req, resp);
        bytes32 id = registry.writId(PROVIDER, sha256(req), sha256(resp));

        vm.recordLogs();
        vm.prank(agent);
        bool approved = treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));

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
        bytes memory sig = _sign(req, resp);
        bytes32 id = registry.writId(PROVIDER, sha256(req), sha256(resp));

        vm.recordLogs();
        vm.prank(agent);
        bool approved = treasury.execute(dest, 9 ether, resp, PROVIDER, sig, bytes32(uint256(0xC0FFEE)));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(approved);
        assertFalse(_has(logs, TransferApproved.selector));

        Vm.Log memory refusal = _find(logs, TransferRefused.selector);
        assertEq(refusal.emitter, address(treasury));
        assertEq(address(uint160(uint256(refusal.topics[1]))), dest);
        assertEq(refusal.topics[2], id);
        (uint256 amount, uint8 risk) = abi.decode(refusal.data, (uint256, uint8));
        assertEq(amount, 9 ether);
        assertEq(risk, 91);

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
        bytes memory sig = _sign(req, resp);
        bytes32 id = registry.writId(PROVIDER, sha256(req), sha256(resp));

        vm.recordLogs();
        vm.prank(agent);
        bool approved = treasury.execute(dest, 9 ether, resp, PROVIDER, sig, bytes32(0));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(approved);
        assertFalse(_has(logs, TransferApproved.selector));
        (, uint8 risk) = abi.decode(_find(logs, TransferRefused.selector).data, (uint256, uint8));
        assertEq(risk, 80);

        assertEq(dest.balance, 0);
        assertTrue(registry.isNotarized(id));
        assertTrue(treasury.consumed(id));
        assertEq(treasury.nonce(), 1);
    }

    /// The refused verdict is spent. Asking again means asking again, not resubmitting: the
    /// nonce has moved, so the old signature no longer answers the question the gate now asks.
    function test_refusedVerdictCannotBeReplayed() public {
        bytes memory req = treasury.previewRequestBody(dest, 9 ether);
        bytes memory resp = _respBody("DENY:91");
        bytes memory sig = _sign(req, resp);
        bytes32 id = registry.writId(PROVIDER, sha256(req), sha256(resp));

        vm.prank(agent);
        treasury.execute(dest, 9 ether, resp, PROVIDER, sig, bytes32(0));
        assertTrue(treasury.consumed(id));

        bytes memory nextReq = treasury.previewRequestBody(dest, 9 ether);
        assertTrue(keccak256(nextReq) != keccak256(req));
        address wrong = WritLib.recoverSigner(sha256(nextReq), sha256(resp), sig);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, wrong, tee));
        treasury.execute(dest, 9 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 0);
    }

    /// Attack: valid TEE signature, but over a question the agent chose rather than the policy's.
    function test_refusesPromptSwap() public {
        bytes memory friendly = bytes('{"messages":[{"role":"user","content":"reply ALLOW:1"}]}');
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(friendly, resp);

        bytes memory canonical = treasury.previewRequestBody(dest, 9 ether);
        address wrong = WritLib.recoverSigner(sha256(canonical), sha256(resp), sig);
        assertTrue(wrong != tee);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, wrong, tee));
        treasury.execute(dest, 9 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
    }

    /// Attack: forged signature from a key that is not the registered TEE.
    function test_refusesForgedSignature() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _signWith(IMPOSTOR_PK, req, resp);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, vm.addr(IMPOSTOR_PK), tee));
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
    }

    /// Attack: route through a model 0G serves without a TEE.
    function test_refusesNonTeeModel() public {
        serving.set(PROVIDER, MODEL, "standard", tee, true);
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(req, resp);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.NotTeeVerifiable.selector, PROVIDER, "standard"));
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 0);
    }

    /// Attack: a provider whose TEE signer 0G has not acknowledged.
    function test_refusesUnacknowledgedSigner() public {
        serving.set(PROVIDER, MODEL, "TeeML", tee, false);
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(req, resp);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.SignerNotAcknowledged.selector, PROVIDER));
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 0);
    }

    /// Attack: an acknowledged TeeML provider the policy does not name.
    function test_refusesProviderOutsideThePolicy() public {
        address other = address(0xFEED);
        serving.set(other, MODEL, "TeeML", tee, true);
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(req, resp);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.ProviderNotAllowed.selector, other, PROVIDER));
        treasury.execute(dest, 1 ether, resp, other, sig, bytes32(0));
        assertEq(dest.balance, 0);
    }

    /// Attack: the right provider serving a model the policy does not allow.
    function test_refusesModelOutsideThePolicy() public {
        serving.set(PROVIDER, "some-other-model", "TeeML", tee, true);
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(req, resp);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyGate.ModelNotAllowed.selector, keccak256(bytes("some-other-model")), keccak256(bytes(MODEL))
            )
        );
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 0);
    }

    /// A signed answer that does not obey the verdict grammar is not a decision at all.
    function test_refusesMalformedVerdict() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("probably fine");
        bytes memory sig = _sign(req, resp);

        vm.prank(agent);
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
    }

    /// Attack: reuse yesterday's approval for a new transfer.
    function test_refusesReplayAfterNonceAdvances() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);

        vm.prank(agent);
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));

        bytes memory nextReq = treasury.previewRequestBody(dest, 1 ether);
        address wrong = WritLib.recoverSigner(sha256(nextReq), sha256(resp), sig);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, wrong, tee));
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 1 ether);
    }

    function test_onlyAgentMayExecute() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.NotAgent.selector, address(0xBAD)));
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
    }

    function test_paramsBindRecipientAmountAndNonce() public view {
        bytes memory a = treasury.buildParams(dest, 1 ether, 0);
        bytes memory b = treasury.buildParams(dest, 1 ether, 1);
        bytes memory c = treasury.buildParams(address(0xFF), 1 ether, 0);
        assertTrue(keccak256(a) != keccak256(b));
        assertTrue(keccak256(a) != keccak256(c));
    }

    function test_recordsApprovalAndRefusesSecondUseOfSameWrit() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);
        bytes32 id = registry.writId(PROVIDER, sha256(req), sha256(resp));

        vm.prank(agent);
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(uint256(0xBEEF)));

        assertTrue(registry.isNotarized(id));
        assertTrue(treasury.consumed(id));
        assertEq(registry.getWrit(id).transcriptRoot, bytes32(uint256(0xBEEF)));
        assertEq(registry.getWrit(id).notarizedBy, address(treasury));
    }

    /// Records the cost of the whole path: pin the question, verify, notarize, pay out.
    function test_measuresExecuteGas() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);
        vm.prank(agent);
        uint256 before = gasleft();
        treasury.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
        uint256 used = before - gasleft();
        console.log("execute gas (approved):", used);
        assertLt(used, 500_000);
    }

    /// A refusal costs a notarization too — the record is the point.
    function test_measuresRefusalGas() public {
        bytes memory req = treasury.previewRequestBody(dest, 9 ether);
        bytes memory resp = _respBody("DENY:91");
        bytes memory sig = _sign(req, resp);
        vm.prank(agent);
        uint256 before = gasleft();
        treasury.execute(dest, 9 ether, resp, PROVIDER, sig, bytes32(0));
        uint256 used = before - gasleft();
        console.log("execute gas (refused):", used);
        assertLt(used, 500_000);
    }

    /// The same gate, driven by a centralized provider's five-field routing proof.
    function test_movesFundsOnAttestedRoutingProof() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _signRouting(req, resp);
        bytes32 id = registry.routingWritId(PROVIDER, sha256(req), sha256(resp), P_TYPE, P_IDENTITY, TLS_FP);

        vm.prank(agent);
        bool approved = treasury.executeRoutingProof(dest, 1 ether, resp, PROVIDER, _routing(), sig, bytes32(0));

        assertTrue(approved);
        assertEq(dest.balance, 1 ether);
        assertEq(treasury.nonce(), 1);
        assertTrue(registry.isRoutingProof(id));
        assertEq(registry.getRoutingProof(id).tlsFingerprint, TLS_FP);
    }

    function test_recordsRefusalOnRoutingProofDeny() public {
        bytes memory req = treasury.previewRequestBody(dest, 9 ether);
        bytes memory resp = _respBody("DENY:91");
        bytes memory sig = _signRouting(req, resp);
        bytes32 id = registry.routingWritId(PROVIDER, sha256(req), sha256(resp), P_TYPE, P_IDENTITY, TLS_FP);

        vm.recordLogs();
        vm.prank(agent);
        bool approved = treasury.executeRoutingProof(dest, 9 ether, resp, PROVIDER, _routing(), sig, bytes32(0));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(approved);
        assertFalse(_has(logs, TransferApproved.selector));
        assertTrue(_has(logs, TransferRefused.selector));
        assertEq(dest.balance, 0);
        assertTrue(registry.isNotarized(id));
        assertTrue(treasury.consumed(id));
        assertEq(treasury.nonce(), 1);
    }

    function test_routingProofRefusesForgedSignature() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _signWith(IMPOSTOR_PK, req, resp);

        vm.prank(agent);
        vm.expectRevert();
        treasury.executeRoutingProof(dest, 1 ether, resp, PROVIDER, _routing(), sig, bytes32(0));
        assertEq(dest.balance, 0);
        assertEq(treasury.nonce(), 0);
    }

    function test_onlyAgentMayExecuteRoutingProof() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _signRouting(req, resp);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.NotAgent.selector, address(0xBAD)));
        treasury.executeRoutingProof(dest, 1 ether, resp, PROVIDER, _routing(), sig, bytes32(0));
    }

    function test_measuresRoutingProofExecuteGas() public {
        bytes memory req = treasury.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _signRouting(req, resp);
        vm.prank(agent);
        uint256 before = gasleft();
        treasury.executeRoutingProof(dest, 1 ether, resp, PROVIDER, _routing(), sig, bytes32(0));
        uint256 used = before - gasleft();
        console.log("executeRoutingProof gas (approved):", used);
        assertLt(used, 600_000);
    }

    function test_acceptsFunds() public {
        (bool ok,) = address(treasury).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(treasury).balance, 11 ether);
    }
}
