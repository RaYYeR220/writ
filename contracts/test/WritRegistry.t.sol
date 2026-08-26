// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {IInferenceServing} from "../src/interfaces/IInferenceServing.sol";
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

    // Centralized routing proof over the same request/response pair, same key.
    string constant P_TYPE = "centralized";
    string constant P_IDENTITY = "openrouter";
    bytes32 constant TLS_FP = 0x67038b7d0b458b9d2e2e8a3451709f84bdcad46a71a36fe82bd7bdb266df2537;
    bytes constant ROUTING_SIG =
        hex"6af690cde50dc856c6a8d024219aa0843eb3c9c90c287f0b59b90173f5a326a564b3208392697ac4a3744220a6f7bb39729d36274510bdf33a704e6422dfb3e31c";

    event RoutingProofNotarized(
        bytes32 indexed id,
        address indexed provider,
        string providerType,
        string providerIdentity,
        bytes32 tlsFingerprint
    );

    event TranscriptAdded(bytes32 indexed id, bytes32 indexed root, address indexed submitter);

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

    /// Records the full on-chain cost of verifying a proof and recording it forever.
    function test_measuresNotarizeGas() public {
        uint256 before = gasleft();
        registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        uint256 used = before - gasleft();
        console.log("notarize gas:", used);
        assertLt(used, 300_000);
    }

    /// The live registry reverts for a provider it has never seen; that must fail closed too.
    function test_revertsForUnregisteredProvider() public {
        address ghost = address(0xC0FFEE);
        vm.expectRevert(abi.encodeWithSelector(IInferenceServing.ServiceNotExist.selector, ghost));
        registry.notarize(ghost, REQ_H, RESP_H, SIG, ROOT);
    }

    function test_notarizesCentralizedRoutingProof() public {
        bytes32 id =
            registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
        assertEq(id, registry.routingWritId(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP));
        assertTrue(registry.isNotarized(id));
        assertTrue(registry.isRoutingProof(id));

        WritRegistry.Writ memory w = registry.getWrit(id);
        assertEq(w.provider, PROVIDER);
        assertEq(w.modelHash, keccak256(bytes(MODEL)));
        assertEq(w.reqHash, REQ_H);
        assertEq(w.respHash, RESP_H);
        assertEq(w.transcriptRoot, ROOT);

        WritRegistry.RoutingProof memory p = registry.getRoutingProof(id);
        assertEq(p.providerType, P_TYPE);
        assertEq(p.providerIdentity, P_IDENTITY);
        assertEq(p.tlsFingerprint, TLS_FP);
        assertEq(registry.writCount(), 1);
    }

    function test_emitsRoutingProofNotarized() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit RoutingProofNotarized(
            registry.routingWritId(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP),
            PROVIDER,
            P_TYPE,
            P_IDENTITY,
            TLS_FP
        );
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
    }

    /// The two proof kinds are domain-separated, so the same pair can hold both without colliding.
    function test_routingWritIdDoesNotCollideWithPlainWritId() public {
        bytes32 plain = registry.writId(PROVIDER, REQ_H, RESP_H);
        bytes32 routing = registry.routingWritId(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP);
        assertTrue(plain != routing);

        registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);

        assertFalse(registry.isRoutingProof(plain));
        assertTrue(registry.isRoutingProof(routing));
        assertEq(registry.writCount(), 2);
    }

    /// Two routing proofs that differ only in attribution are different writs.
    function test_routingWritIdBindsTheMetadata() public view {
        bytes32 a = registry.routingWritId(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP);
        assertTrue(a != registry.routingWritId(PROVIDER, REQ_H, RESP_H, P_TYPE, "aliyun", TLS_FP));
        assertTrue(a != registry.routingWritId(PROVIDER, REQ_H, RESP_H, "decentralized", P_IDENTITY, TLS_FP));
        assertTrue(
            a != registry.routingWritId(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, bytes32(uint256(TLS_FP) + 1))
        );
    }

    function test_getRoutingProofRevertsForAPlainWrit() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.NotARoutingProof.selector, id));
        registry.getRoutingProof(id);
    }

    /// The `:`-joined format is ambiguous under field splitting, so a delimiter in a label could
    /// record a valid proof under mis-attributed metadata. Reject it before it is recorded.
    function test_rejectsColonInProviderType() public {
        vm.expectRevert(WritRegistry.RoutingFieldHasDelimiter.selector);
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, "centralized:open", "router", TLS_FP, ROUTING_SIG, ROOT);
    }

    function test_rejectsColonInProviderIdentity() public {
        vm.expectRevert(WritRegistry.RoutingFieldHasDelimiter.selector);
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, "centralized", "open:router", TLS_FP, ROUTING_SIG, ROOT);
    }

    function test_rejectsOverLongRoutingField() public {
        string memory long = "0123456789012345678901234567890123";
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.RoutingFieldTooLong.selector, uint256(34)));
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, long, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
    }

    function test_rejectsEmptyRoutingField() public {
        vm.expectRevert(WritRegistry.RoutingFieldEmpty.selector);
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, "", P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
    }

    function test_routingProofRequiresAcknowledgedSigner() public {
        serving.set(PROVIDER, MODEL, "TeeML", TEE, false);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.SignerNotAcknowledged.selector, PROVIDER));
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
    }

    function test_routingProofRequiresTeeML() public {
        serving.set(PROVIDER, MODEL, "standard", TEE, true);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.NotTeeVerifiable.selector, PROVIDER, "standard"));
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
    }

    /// Swapping the recorded identity changes the signed text, so recovery fails.
    function test_routingProofRejectsMisattributedIdentity() public {
        vm.expectRevert();
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, "aliyun", TLS_FP, ROUTING_SIG, ROOT);
    }

    function test_routingProofRejectsAChatSignature() public {
        vm.expectRevert();
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, SIG, ROOT);
    }

    function test_revertsOnDuplicateRoutingNotarization() public {
        bytes32 id =
            registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.AlreadyNotarized.selector, id));
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
    }

    function test_measuresRoutingNotarizeGas() public {
        uint256 before = gasleft();
        registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
        uint256 used = before - gasleft();
        console.log("notarizeRoutingProof gas:", used);
        assertLt(used, 400_000);
    }

    function test_anyoneMayNotarize() public {
        vm.prank(address(0x1234));
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        assertEq(registry.getWrit(id).notarizedBy, address(0x1234));
    }

    /// The root supplied at notarization is the first candidate, not a privileged one.
    function test_notarizationSeedsTheFirstTranscriptRoot() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        bytes32[] memory roots = registry.transcriptRoots(id);
        assertEq(roots.length, 1);
        assertEq(roots[0], ROOT);
        assertEq(registry.getWrit(id).transcriptRoot, ROOT);
    }

    /// A writ notarized without a pointer starts with no candidates at all.
    function test_notarizationWithoutARootListsNothing() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, bytes32(0));
        assertEq(registry.transcriptRoots(id).length, 0);
    }

    function test_seedsTheFirstTranscriptRootOnTheRoutingPath() public {
        bytes32 id =
            registry.notarizeRoutingProof(PROVIDER, REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG, ROOT);
        bytes32[] memory roots = registry.transcriptRoots(id);
        assertEq(roots.length, 1);
        assertEq(roots[0], ROOT);
    }

    function test_anyoneMayAppendATranscriptRoot() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        bytes32 second = bytes32(uint256(0xB0B));

        vm.expectEmit(true, true, true, true, address(registry));
        emit TranscriptAdded(id, second, address(0x1234));
        vm.prank(address(0x1234));
        registry.addTranscript(id, second);

        bytes32[] memory roots = registry.transcriptRoots(id);
        assertEq(roots.length, 2);
        assertEq(roots[0], ROOT);
        assertEq(roots[1], second);
    }

    /// Notarizing is permissionless and records are immutable, so a front-runner who learns a
    /// chat id can fix a junk pointer forever. Appending is the answer: the real root can still
    /// be published, and a consumer that re-derives the hashes sees which candidate is real.
    function test_aFrontRunnersJunkRootDoesNotShutOutTheRealOne() public {
        bytes32 junk = bytes32(uint256(0xDEADBEEF));
        bytes32 real = bytes32(uint256(0xFACADE));

        vm.prank(address(0xF00D));
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, junk);

        vm.prank(address(0xA11CE));
        registry.addTranscript(id, real);

        bytes32[] memory roots = registry.transcriptRoots(id);
        assertEq(roots.length, 2);
        assertEq(roots[0], junk);
        assertEq(roots[1], real);
        // The stale pointer is still the one the record was born with, and always will be.
        assertEq(registry.getWrit(id).transcriptRoot, junk);
    }

    function test_addTranscriptRejectsADuplicateRoot() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.TranscriptAlreadyListed.selector, ROOT));
        registry.addTranscript(id, ROOT);
    }

    function test_addTranscriptRejectsTheZeroRoot() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        vm.expectRevert(WritRegistry.TranscriptRootEmpty.selector);
        registry.addTranscript(id, bytes32(0));
    }

    function test_addTranscriptRequiresTheWritToExist() public {
        bytes32 ghost = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.NotNotarized.selector, ghost));
        registry.addTranscript(ghost, ROOT);
    }

    function test_transcriptRootsOfAnUnknownWritAreEmpty() public view {
        assertEq(registry.transcriptRoots(keccak256("nope")).length, 0);
    }

    /// Appending is free to anyone, so it must be bounded or the list could be griefed into
    /// gas nobody can afford to read.
    function test_transcriptRootsAreCapped() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        uint256 cap = registry.MAX_TRANSCRIPT_ROOTS();

        for (uint256 i = 1; i < cap; ++i) {
            registry.addTranscript(id, bytes32(i + 1));
        }
        assertEq(registry.transcriptRoots(id).length, cap);

        bytes32 overflowing = bytes32(cap + 99);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.TooManyTranscriptRoots.selector, cap));
        registry.addTranscript(id, overflowing);
    }

    function test_measuresAddTranscriptGas() public {
        bytes32 id = registry.notarize(PROVIDER, REQ_H, RESP_H, SIG, ROOT);
        uint256 before = gasleft();
        registry.addTranscript(id, bytes32(uint256(0xB0B)));
        uint256 used = before - gasleft();
        console.log("addTranscript gas:", used);
        assertLt(used, 100_000);
    }
}
