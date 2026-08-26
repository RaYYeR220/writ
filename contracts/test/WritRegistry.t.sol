// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {MockInferenceServing} from "./mocks/MockInferenceServing.sol";

contract WritRegistryTest is Test {
    bytes32 constant REQ_H = 0xccdfb98dd427a783eb317f4d7a5170c4677d7c3f8f087b5413ca0f0eade91c88;
    bytes32 constant RESP_H = 0xf0219cdd97103db1958d11c92a595576441f6620b2debc86a980892700e73608;
    bytes constant SIG =
        hex"45a0f6fdfb75a69764265ac9539e979398f6584b48e031cb7dd5b298829f78780dc8f223289452f22fd25b64c51e5da821fdafdef59e021794038c302865ca4d1b";
    address constant TEE = 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A;
    address constant PROVIDER = address(0xBEEF);
    bytes32 constant ROOT = bytes32(uint256(0xA11CE));
    string constant MODEL = "0GM-1.0-35B-A3B";

    MockInferenceServing serving;
    WritRegistry registry;

    function setUp() public {
        serving = new MockInferenceServing();
        registry = new WritRegistry(address(serving));
        serving.set(PROVIDER, MODEL, "TeeML", TEE, true);
    }

    function test_notarizesValidProof() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        assertEq(id, registry.writId(PROVIDER, REQ_H, RESP_H));
        assertTrue(registry.isNotarized(id));

        WritRegistry.Writ memory w = registry.getWrit(id);
        assertEq(w.provider, PROVIDER);
        assertEq(w.modelHash, keccak256(bytes(MODEL)));
        assertEq(w.reqHash, REQ_H);
        assertEq(w.respHash, RESP_H);
        assertEq(w.transcriptRoot, ROOT);
        assertEq(w.notarizedBy, address(this));
        assertEq(registry.writCount(), 1);
    }

    function test_revertsWhenSignerNotAcknowledged() public {
        serving.set(PROVIDER, MODEL, "TeeML", TEE, false);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.SignerNotAcknowledged.selector, PROVIDER));
        registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
    }

    function test_revertsWhenVerifiabilityIsNotTeeML() public {
        serving.set(PROVIDER, "gpt-oss-120b", "standard", TEE, true);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.NotTeeVerifiable.selector, PROVIDER, "standard"));
        registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
    }

    function test_revertsWhenSignerIsNotTheRegisteredTee() public {
        address other = address(0xDEAD);
        serving.set(PROVIDER, MODEL, "TeeML", other, true);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, TEE, other));
        registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
    }

    function test_revertsOnTamperedResponseHash() public {
        bytes32 bad = bytes32(uint256(RESP_H) + 1);
        vm.expectRevert();
        registry.notarize(PROVIDER, REQ_H, bad, SIG, ROOT);
    }

    function test_revertsOnDuplicateNotarization() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.AlreadyNotarized.selector, id));
        registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
    }

    function test_getWritRevertsForUnknownId() public {
        bytes32 id = registry.writId(PROVIDER, REQ_H, RESP_H);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.NotNotarized.selector, id));
        registry.getWrit(id);
    }

    function test_anyoneMayNotarize() public {
        vm.prank(address(0x1234));
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        assertEq(registry.getWrit(id).notarizedBy, address(0x1234));
    }
}
