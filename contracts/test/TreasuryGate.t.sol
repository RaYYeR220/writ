// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {TreasuryGate} from "../src/TreasuryGate.sol";
import {PolicyGate} from "../src/PolicyGate.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {WritLib} from "../src/WritLib.sol";
import {MockInferenceServing} from "./mocks/MockInferenceServing.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @dev Covers the escape hatch: if the 0G Compute provider stops producing signatures the
///      treasury would otherwise be bricked, so the owner may sweep it after a long silence.
contract TreasuryGateRecoveryTest is Test {
    uint256 constant TEE_PK = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address constant PROVIDER = address(0xBEEF);
    string constant MODEL = "0GM-1.0-35B-A3B";

    bytes constant HEAD =
        '{"model":"0GM-1.0-35B-A3B","temperature":0,"messages":[{"role":"system","content":"Reply with exactly ALLOW:<0-100> or DENY:<0-100>."},{"role":"user","content":"Approve this transfer? ';
    bytes constant TAIL = '"}]}';

    event Recovered(address indexed to, uint256 amount, uint64 lastAttestationAt);

    MockInferenceServing serving;
    WritRegistry registry;
    TreasuryGate gate;
    address tee;

    address agent = address(0xA9);
    address owner = address(0x0FE);
    address payable dest = payable(address(0xD1));
    address payable rescue = payable(address(0xF00D));

    bytes32 constant TLS_FP = 0x67038b7d0b458b9d2e2e8a3451709f84bdcad46a71a36fe82bd7bdb266df2537;

    function setUp() public {
        vm.warp(1_700_000_000);
        tee = vm.addr(TEE_PK);
        serving = new MockInferenceServing();
        serving.set(PROVIDER, MODEL, "TeeML", tee, true);
        registry = new WritRegistry(address(serving));
        gate = new TreasuryGate(
            registry,
            agent,
            owner,
            PolicyGate.Policy({
                promptHead: HEAD,
                promptTail: TAIL,
                allowedModelHash: keccak256(bytes(MODEL)),
                allowedProvider: PROVIDER,
                maxRisk: 50
            })
        );
        vm.deal(address(gate), 10 ether);
    }

    function _respBody(string memory content) internal pure returns (bytes memory) {
        return abi.encodePacked('{"id":"c1","choices":[{"message":{"content":"', content, '"}}]}');
    }

    function _sign(bytes memory req, bytes memory resp) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n129", WritLib.signedText(sha256(req), sha256(resp)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEE_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _attest(uint256 amount, string memory verdict) internal {
        bytes memory req = gate.previewRequestBody(dest, amount);
        bytes memory resp = _respBody(verdict);
        registry.notarize(PROVIDER, sha256(req), sha256(resp), _sign(req, resp), bytes32(0));
        vm.prank(agent);
        gate.execute(dest, amount, resp, PROVIDER);
    }

    function test_ownerAndAgentAreDistinctRoles() public view {
        assertEq(gate.agent(), agent);
        assertEq(gate.owner(), owner);
    }

    /// A zero clock would make the escape hatch available the moment the gate exists.
    function test_clockStartsAtDeployment() public view {
        assertEq(gate.lastAttestationAt(), uint64(block.timestamp));
        assertEq(gate.RECOVERY_DELAY(), 30 days);
    }

    function test_recoverRevertsForNonOwner() public {
        vm.warp(block.timestamp + 365 days);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.NotOwner.selector, agent));
        gate.recover(rescue);
        assertEq(address(gate).balance, 10 ether);
    }

    function test_recoverRevertsBeforeTheDelayElapses() public {
        uint64 availableAt = gate.lastAttestationAt() + gate.RECOVERY_DELAY();
        vm.warp(block.timestamp + 29 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.RecoveryNotYetAvailable.selector, availableAt));
        gate.recover(rescue);
        assertEq(address(gate).balance, 10 ether);
    }

    /// The boundary is exclusive: the delay must have fully elapsed.
    function test_recoverRevertsExactlyOnTheBoundary() public {
        uint64 availableAt = gate.lastAttestationAt() + gate.RECOVERY_DELAY();
        vm.warp(availableAt);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.RecoveryNotYetAvailable.selector, availableAt));
        gate.recover(rescue);

        vm.warp(uint256(availableAt) + 1);
        vm.prank(owner);
        gate.recover(rescue);
        assertEq(rescue.balance, 10 ether);
    }

    function test_recoverSweepsTheWholeBalanceAfterTheDelay() public {
        uint64 last = gate.lastAttestationAt();
        vm.warp(block.timestamp + 31 days);

        vm.recordLogs();
        vm.prank(owner);
        gate.recover(rescue);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != Recovered.selector) continue;
            found = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), rescue);
            (uint256 amount, uint64 reported) = abi.decode(logs[i].data, (uint256, uint64));
            assertEq(amount, 10 ether);
            assertEq(reported, last);
        }
        assertTrue(found);
        assertEq(rescue.balance, 10 ether);
        assertEq(address(gate).balance, 0);
    }

    /// An approval proves the provider is still signing, so the clock restarts.
    function test_approvalPostponesRecovery() public {
        vm.warp(block.timestamp + 29 days);
        _attest(1 ether, "ALLOW:12");
        assertEq(gate.lastAttestationAt(), uint64(block.timestamp));

        uint64 availableAt = gate.lastAttestationAt() + gate.RECOVERY_DELAY();
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.RecoveryNotYetAvailable.selector, availableAt));
        gate.recover(rescue);
    }

    /// A refusal proves it just as well: the provider produced a verifiable proof either way.
    function test_refusalPostponesRecovery() public {
        vm.warp(block.timestamp + 29 days);
        _attest(9 ether, "DENY:91");
        assertEq(gate.lastAttestationAt(), uint64(block.timestamp));
        assertEq(dest.balance, 0);

        uint64 availableAt = gate.lastAttestationAt() + gate.RECOVERY_DELAY();
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.RecoveryNotYetAvailable.selector, availableAt));
        gate.recover(rescue);
        assertEq(address(gate).balance, 10 ether);
    }

    /// A centralized provider's routing proof is evidence of liveness just the same.
    function test_routingProofPostponesRecovery() public {
        vm.warp(block.timestamp + 29 days);

        bytes memory req = gate.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            WritLib.routingProofText(sha256(req), sha256(resp), "centralized", "openrouter", TLS_FP)
        );
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(TEE_PK, digest);
        registry.notarizeRoutingProof(
            PROVIDER,
            sha256(req),
            sha256(resp),
            "centralized",
            "openrouter",
            TLS_FP,
            abi.encodePacked(r, sg, v),
            bytes32(0)
        );

        vm.prank(agent);
        gate.executeRoutingProof(
            dest, 1 ether, resp, PROVIDER, WritRegistry.RoutingProof("centralized", "openrouter", TLS_FP)
        );

        assertEq(gate.lastAttestationAt(), uint64(block.timestamp));
        assertEq(dest.balance, 1 ether);

        uint64 availableAt = gate.lastAttestationAt() + gate.RECOVERY_DELAY();
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.RecoveryNotYetAvailable.selector, availableAt));
        gate.recover(rescue);
    }

    /// A failed verification is not an attestation, so it must not move the clock. The forged
    /// proof never reaches the gate at all: it cannot be notarized, so there is nothing to spend.
    function test_failedVerificationDoesNotPostponeRecovery() public {
        uint64 last = gate.lastAttestationAt();
        vm.warp(block.timestamp + 29 days);

        bytes memory req = gate.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n129", WritLib.signedText(sha256(req), sha256(resp)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBADBAD), digest);
        (bytes32 rq, bytes32 rs) = (sha256(req), sha256(resp));

        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, vm.addr(0xBADBAD), tee));
        registry.notarize(PROVIDER, rq, rs, abi.encodePacked(r, s, v), bytes32(0));

        bytes32 id = registry.writId(PROVIDER, rq, rs);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.WritNotNotarized.selector, id));
        gate.execute(dest, 1 ether, resp, PROVIDER);

        assertEq(gate.lastAttestationAt(), last);

        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        gate.recover(rescue);
        assertEq(rescue.balance, 10 ether);
    }

    /// Sweeping to the zero address would burn the treasury it exists to rescue.
    function test_recoverRevertsForZeroRecipient() public {
        vm.warp(block.timestamp + 31 days);
        vm.prank(owner);
        vm.expectRevert(TreasuryGate.ZeroRecipient.selector);
        gate.recover(address(0));
        assertEq(address(gate).balance, 10 ether);
    }

    /// A sweep must restart the clock, or the hatch stays open. Once the window has elapsed it
    /// stays elapsed, so every later deposit would be sweepable the instant it landed, with no
    /// timelock at all — which is the opposite of what `RECOVERY_DELAY` is for.
    function test_recoverRestartsTheClock() public {
        vm.warp(block.timestamp + 31 days);
        vm.prank(owner);
        gate.recover(rescue);
        assertEq(gate.lastAttestationAt(), uint64(block.timestamp));

        // A fresh deposit is not immediately sweepable.
        vm.deal(address(gate), 5 ether);
        uint64 availableAt = gate.recoveryAvailableAt();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.RecoveryNotYetAvailable.selector, availableAt));
        gate.recover(rescue);
        assertEq(address(gate).balance, 5 ether);

        // It becomes sweepable once a second full delay has passed, and not before.
        vm.warp(uint256(availableAt) + 1);
        vm.prank(owner);
        gate.recover(rescue);
        assertEq(rescue.balance, 15 ether);
        assertEq(gate.lastAttestationAt(), uint64(block.timestamp));
    }

    /// A recovery that reverts must not move the clock either.
    function test_aFailedRecoverDoesNotRestartTheClock() public {
        RejectsEther sink = new RejectsEther();
        uint64 last = gate.lastAttestationAt();
        vm.warp(block.timestamp + 31 days);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.TransferFailed.selector, address(sink), 10 ether));
        gate.recover(address(sink));
        assertEq(gate.lastAttestationAt(), last);

        vm.prank(owner);
        gate.recover(rescue);
        assertEq(rescue.balance, 10 ether);
    }

    function test_recoverRevertsWhenTheDestinationRejectsFunds() public {
        RejectsEther sink = new RejectsEther();
        vm.warp(block.timestamp + 31 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.TransferFailed.selector, address(sink), 10 ether));
        gate.recover(address(sink));
        assertEq(address(gate).balance, 10 ether);
    }
}

contract RejectsEther {
    receive() external payable {
        revert("no");
    }
}
