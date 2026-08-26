// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyGate} from "../src/PolicyGate.sol";
import {PolicyGateHarness} from "./harness/PolicyGateHarness.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {WritLib} from "../src/WritLib.sol";
import {VerdictLib} from "../src/VerdictLib.sol";
import {MockInferenceServing} from "./mocks/MockInferenceServing.sol";

contract PolicyGateTest is Test {
    uint256 constant TEE_PK = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address constant PROVIDER = address(0xBEEF);
    string constant MODEL = "0GM-1.0-35B-A3B";
    uint256 constant PID = 1;

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
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n129", WritLib.signedText(sha256(req), sha256(resp)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEE_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_consumesAllowVerdict() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");

        (bytes32 id, uint8 risk) = gate.consume(PID, params, resp, PROVIDER, _sign(req, resp), bytes32(0));
        assertEq(risk, 12);
        assertTrue(gate.consumed(id));
        assertTrue(registry.isNotarized(id));
    }

    function test_revertsOnDenyVerdict() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("DENY:87");
        bytes memory sig = _sign(req, resp);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.VerdictDenied.selector, uint8(87)));
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    function test_revertsWhenRiskExceedsCeiling() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:80");
        bytes memory sig = _sign(req, resp);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.RiskTooHigh.selector, uint8(80), uint8(50)));
        gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
    }

    /// The prompt-swap attack: a valid TEE signature over a DIFFERENT question.
    function test_revertsWhenProofIsForADifferentQuestion() public {
        bytes memory friendlyReq = bytes('{"messages":[{"role":"user","content":"say ALLOW:1"}]}');
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(friendlyReq, resp);

        bytes memory params = bytes("recipient=0x01 amount=999999 nonce=0");
        vm.expectRevert();
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

    function test_revertsWhenWritAlreadyConsumed() public {
        bytes memory params = bytes("recipient=0x01 amount=5 nonce=0");
        bytes memory req = gate.buildRequestBody(PID, params);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);
        (bytes32 id,) = gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
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

        (, uint8 risk) = gate.consume(PID, params, resp, PROVIDER, sig, bytes32(0));
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
