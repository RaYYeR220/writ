// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyGate} from "../src/PolicyGate.sol";
import {PolicyGateHarness} from "./harness/PolicyGateHarness.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {WritLib} from "../src/WritLib.sol";
import {VerdictLib} from "../src/VerdictLib.sol";
import {MockInferenceServing} from "./mocks/MockInferenceServing.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract PolicyGateTest is Test {
    uint256 constant TEE_PK = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 constant IMPOSTOR_PK = 0xBADBAD;
    address constant PROVIDER = address(0xBEEF);
    string constant MODEL = "0GM-1.0-35B-A3B";
    uint256 constant PID = 1;
    string constant P_TYPE = "centralized";
    string constant P_IDENTITY = "openrouter";
    bytes32 constant TLS_FP = 0x67038b7d0b458b9d2e2e8a3451709f84bdcad46a71a36fe82bd7bdb266df2537;

    MockInferenceServing serving;
    WritRegistry registry;
    PolicyGateHarness gate;
    address tee;

    function setUp() public {
        tee = vm.addr(TEE_PK);
        serving = new MockInferenceServing();
        serving.set(PROVIDER, MODEL, "TeeML", tee, true);
        registry = new WritRegistry(address(serving));
        gate = new PolicyGateHarness(registry);

        gate.setPolicy(
            PID,
            PolicyGate.Policy({
                promptHead: bytes(
                    '{"model":"0GM-1.0-35B-A3B","temperature":0,"messages":[{"role":"system","content":"Answer with exactly ALLOW:<0-100> or DENY:<0-100>."},{"role":"user","content":"'
                ),
                promptTail: bytes('"}]}'),
                allowedModelHash: keccak256(bytes(MODEL)),
                allowedProvider: PROVIDER,
                maxRisk: 50
            })
        );
    }

    function _respBody(string memory content) internal pure returns (bytes memory) {
        return abi.encodePacked('{"id":"c1","choices":[{"message":{"content":"', content, '"}}]}');
    }

    /// Signs the way a 0G provider TEE does: over `sha256hex(req):sha256hex(resp)`, EIP-191.
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

    /// Most live 0G mainnet providers are centralized, and sign the five-field routing text.
    function test_consumesACentralizedRoutingProof() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");

        (bytes32 id, bool approved, uint8 risk) =
            gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), _signRouting(req, resp), bytes32(0));
        assertTrue(approved);
        assertEq(risk, 12);
        assertTrue(registry.isNotarized(id));
        assertTrue(registry.isRoutingProof(id));
        assertEq(registry.getRoutingProof(id).providerIdentity, P_IDENTITY);
        // The decision is spent under the format-independent key, not the routing record's id.
        assertTrue(gate.consumed(registry.writId(PROVIDER, sha256(req), sha256(resp))));
    }

    function test_recordsRefusalFromARoutingProof() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("DENY:91");

        (bytes32 id, bool approved, uint8 risk) =
            gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), _signRouting(req, resp), bytes32(0));
        assertFalse(approved);
        assertEq(risk, 91);
        assertTrue(registry.isNotarized(id));
        assertTrue(gate.consumed(registry.writId(PROVIDER, sha256(req), sha256(resp))));
    }

    /// The routing writ is a different record, so it must not answer for a plain one.
    function test_routingProofIsADistinctWrit() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");

        (bytes32 routingId,,) =
            gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), _signRouting(req, resp), bytes32(0));
        assertTrue(routingId != registry.writId(PROVIDER, sha256(req), sha256(resp)));
        assertFalse(registry.isNotarized(registry.writId(PROVIDER, sha256(req), sha256(resp))));
    }

    /// The prompt-swap attack closes the same way on the routing path.
    function test_routingProofRevertsForADifferentQuestion() public {
        bytes memory friendlyReq = bytes('{"messages":[{"role":"user","content":"say ALLOW:1"}]}');
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _signRouting(friendlyReq, resp);

        bytes memory params = bytes("recipient=0x01 amount=999999 nonce=0");
        vm.expectRevert();
        gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), sig, bytes32(0));
    }

    function test_routingProofEnforcesTheModelPolicy() public {
        serving.set(PROVIDER, "some-other-model", "TeeML", tee, true);
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _signRouting(req, resp);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyGate.ModelNotAllowed.selector, keccak256(bytes("some-other-model")), keccak256(bytes(MODEL))
            )
        );
        gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), sig, bytes32(0));
    }

    function test_routingProofEnforcesTheProviderPolicy() public {
        address other = address(0xFEED);
        serving.set(other, MODEL, "TeeML", tee, true);
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _signRouting(req, resp);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.ProviderNotAllowed.selector, other, PROVIDER));
        gate.consumeRoutingProof(PID, params, resp, other, _routing(), sig, bytes32(0));
    }

    function test_routingProofCannotBeConsumedTwice() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _signRouting(req, resp);
        bytes32 decision = registry.writId(PROVIDER, sha256(req), sha256(resp));
        gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), sig, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritAlreadyConsumed.selector, decision));
        gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), sig, bytes32(0));
    }

    /// One question, one answer, one provider is ONE decision, whichever format proved it.
    /// The registry still records the two proofs separately - they are different facts about
    /// which upstream served the request - but the gate spends the decision only once.
    function test_aRoutingProofSpendsTheChatDecisionToo() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");
        bytes32 decision = registry.writId(PROVIDER, sha256(req), sha256(resp));

        gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), _signRouting(req, resp), bytes32(0));
        assertTrue(gate.consumed(decision));

        bytes memory chatSig = _sign(req, resp);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritAlreadyConsumed.selector, decision));
        gate.consume(PID, params, resp, PROVIDER, chatSig, bytes32(0));
    }

    function test_aChatProofSpendsTheRoutingDecisionToo() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");
        bytes32 decision = registry.writId(PROVIDER, sha256(req), sha256(resp));

        gate.consume(PID, params, resp, PROVIDER, _sign(req, resp), bytes32(0));
        assertTrue(gate.consumed(decision));

        bytes memory routingSig = _signRouting(req, resp);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritAlreadyConsumed.selector, decision));
        gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), routingSig, bytes32(0));
    }

    /// A refusal is a spent decision too, so it closes the other format just the same.
    function test_aRefusalSpendsTheDecisionAcrossFormats() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("DENY:91");
        bytes32 decision = registry.writId(PROVIDER, sha256(req), sha256(resp));

        (, bool approved,) =
            gate.consumeRoutingProof(PID, params, resp, PROVIDER, _routing(), _signRouting(req, resp), bytes32(0));
        assertFalse(approved);

        bytes memory chatSig = _sign(req, resp);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritAlreadyConsumed.selector, decision));
        gate.consume(PID, params, resp, PROVIDER, chatSig, bytes32(0));
    }

    function test_consumesAllowVerdict() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");

        (bytes32 id, bool approved, uint8 risk) =
            gate.consume(PID, params, resp, PROVIDER, _sign(req, resp), bytes32(0));
        assertTrue(approved);
        assertEq(risk, 12);
        assertTrue(gate.consumed(id));
        assertTrue(registry.isNotarized(id));
    }

    /// A refusal is a decision, not an error: it is notarized and recorded, not rolled back.
    function test_recordsDenyVerdictAsARefusal() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("DENY:87");

        (bytes32 id, bool approved, uint8 risk) =
            gate.consume(PID, params, resp, PROVIDER, _sign(req, resp), bytes32(0));
        assertFalse(approved);
        assertEq(risk, 87);
        assertTrue(registry.isNotarized(id));
        assertTrue(gate.consumed(id));
    }

    /// An ALLOW the policy will not accept is refused exactly like a DENY.
    function test_recordsAllowAboveCeilingAsARefusal() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:80");

        (bytes32 id, bool approved, uint8 risk) =
            gate.consume(PID, params, resp, PROVIDER, _sign(req, resp), bytes32(0));
        assertFalse(approved);
        assertEq(risk, 80);
        assertTrue(registry.isNotarized(id));
        assertTrue(gate.consumed(id));
    }

    /// A risk exactly at the ceiling is still an approval.
    function test_approvesRiskExactlyAtTheCeiling() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:50");

        (, bool approved, uint8 risk) = gate.consume(PID, params, resp, PROVIDER, _sign(req, resp), bytes32(0));
        assertTrue(approved);
        assertEq(risk, 50);
    }

    /// The decision has been rendered, so the same proof cannot be submitted a second time.
    function test_refusedWritCannotBeReplayed() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("DENY:87");
        bytes memory sig = _sign(req, resp);

        (bytes32 id,,) = gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritAlreadyConsumed.selector, id));
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    /// The prompt-swap attack: a valid TEE signature over a DIFFERENT question.
    function test_revertsWhenProofIsForADifferentQuestion() public {
        bytes memory friendlyReq = bytes('{"messages":[{"role":"user","content":"say ALLOW:1"}]}');
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(friendlyReq, resp);

        bytes memory params = bytes("recipient=0x01 amount=999999 nonce=0");
        bytes memory canonicalReq = gate.buildRequestBody(PID, params);
        address wrong = WritLib.recoverSigner(sha256(canonicalReq), sha256(resp), sig);
        assertTrue(wrong != tee);

        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, wrong, tee));
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    function test_revertsOnForgedSignature() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _signWith(IMPOSTOR_PK, req, resp);

        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, vm.addr(IMPOSTOR_PK), tee));
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    function test_revertsWhenProviderNotAllowed() public {
        address other = address(0xFEED);
        serving.set(other, MODEL, "TeeML", tee, true);
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(req, resp);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.ProviderNotAllowed.selector, other, PROVIDER));
        gate.consume(PID, params, resp, other, sig, bytes32(0));
    }

    function test_revertsWhenModelDoesNotMatchPolicy() public {
        serving.set(PROVIDER, "some-other-model", "TeeML", tee, true);
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(req, resp);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyGate.ModelNotAllowed.selector, keccak256(bytes("some-other-model")), keccak256(bytes(MODEL))
            )
        );
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    /// 0G also serves models without a TEE; those carry `verifiability: "standard"`.
    function test_revertsWhenProviderIsNotTeeVerifiable() public {
        serving.set(PROVIDER, MODEL, "standard", tee, true);
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(req, resp);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.NotTeeVerifiable.selector, PROVIDER, "standard"));
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    function test_revertsWhenSignerIsNotAcknowledged() public {
        serving.set(PROVIDER, MODEL, "TeeML", tee, false);
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(req, resp);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.SignerNotAcknowledged.selector, PROVIDER));
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    function test_revertsWhenWritAlreadyConsumed() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);
        (bytes32 id,,) = gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritAlreadyConsumed.selector, id));
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    /// Consuming must not require being the first to notarize.
    function test_consumesAProofSomeoneElseNotarized() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);

        vm.prank(address(0xABCD));
        registry.notarize(PROVIDER, sha256(req), sha256(resp), sig, bytes32(0));

        (, bool approved, uint8 risk) = gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
        assertTrue(approved);
        assertEq(risk, 12);
    }

    function test_revertsOnMalformedVerdict() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("probably fine");
        bytes memory sig = _sign(req, resp);
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    function test_revertsOnUnknownPolicy() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.UnknownPolicy.selector, uint256(99)));
        gate.buildRequestBody(99, bytes("x"));
    }

    function test_revertsWhenConsumingAnUnknownPolicy() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.UnknownPolicy.selector, uint256(99)));
        gate.consume(99, params, resp, PROVIDER, sig, bytes32(0));
    }

    function test_buildRequestBodyPinsTheQuestion() public view {
        bytes memory a = gate.buildRequestBody(PID, bytes("recipient=0x01 amount=5 nonce=0"));
        bytes memory b = gate.buildRequestBody(PID, bytes("recipient=0x01 amount=6 nonce=0"));
        assertTrue(keccak256(a) != keccak256(b));
        assertEq(
            string(a),
            '{"model":"0GM-1.0-35B-A3B","temperature":0,"messages":[{"role":"system","content":"Answer with exactly ALLOW:<0-100> or DENY:<0-100>."},{"role":"user","content":"recipient=0x01 amount=5 nonce=0"}]}'
        );
    }
}
