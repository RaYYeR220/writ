// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PolicyGateFactory} from "../src/PolicyGateFactory.sol";
import {TreasuryGate} from "../src/TreasuryGate.sol";
import {PolicyGate} from "../src/PolicyGate.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {WritLib} from "../src/WritLib.sol";
import {MockInferenceServing} from "./mocks/MockInferenceServing.sol";

contract PolicyGateFactoryTest is Test {
    uint256 constant TEE_PK = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address constant PROVIDER = address(0xBEEF);
    string constant MODEL = "0GM-1.0-35B-A3B";

    bytes constant HEAD =
        '{"model":"0GM-1.0-35B-A3B","temperature":0,"messages":[{"role":"system","content":"Reply with exactly ALLOW:<0-100> or DENY:<0-100>."},{"role":"user","content":"Approve this transfer? ';
    bytes constant TAIL = '"}]}';

    event GateDeployed(address indexed gate, address indexed owner, address indexed deployer, bytes32 modelHash);

    MockInferenceServing serving;
    WritRegistry registry;
    PolicyGateFactory factory;
    address tee;

    address owner = address(0x0FE);
    address agent = address(0xA9);
    address payable dest = payable(address(0xD1));

    function setUp() public {
        tee = vm.addr(TEE_PK);
        serving = new MockInferenceServing();
        serving.set(PROVIDER, MODEL, "TeeML", tee, true);
        registry = new WritRegistry(address(serving));
        factory = new PolicyGateFactory(registry);
    }

    function _policy(uint8 maxRisk) internal pure returns (PolicyGate.Policy memory) {
        return PolicyGate.Policy({
            promptHead: HEAD,
            promptTail: TAIL,
            allowedModelHash: keccak256(bytes(MODEL)),
            allowedProvider: PROVIDER,
            maxRisk: maxRisk
        });
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

    function test_deploysAWorkingGate() public {
        vm.prank(owner);
        TreasuryGate gate = TreasuryGate(payable(factory.deployGate(_policy(50), agent, owner)));
        vm.deal(address(gate), 10 ether);

        assertEq(address(gate.registry()), address(registry));
        assertEq(gate.agent(), agent);
        assertEq(gate.owner(), owner);
        assertEq(gate.owner(), owner);

        bytes memory req = gate.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:12");
        bytes memory sig = _sign(req, resp);

        vm.prank(agent);
        gate.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 1 ether);
    }

    /// The gate must run on the policy it was handed, not on a factory default.
    function test_gateRefusesAboveTheCeilingItWasGiven() public {
        vm.prank(owner);
        TreasuryGate gate = TreasuryGate(payable(factory.deployGate(_policy(10), agent, owner)));
        vm.deal(address(gate), 10 ether);

        assertEq(gate.getPolicy(gate.POLICY_ID()).maxRisk, 10);

        bytes memory req = gate.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:80");
        bytes memory sig = _sign(req, resp);

        vm.prank(agent);
        bool approved = gate.execute(dest, 1 ether, resp, PROVIDER, sig, bytes32(0));
        assertFalse(approved);
        assertEq(dest.balance, 0);
    }

    function test_gateEnforcesTheProviderItWasGiven() public {
        address other = address(0xFEED);
        serving.set(other, MODEL, "TeeML", tee, true);

        vm.prank(owner);
        TreasuryGate gate = TreasuryGate(payable(factory.deployGate(_policy(50), agent, owner)));
        vm.deal(address(gate), 10 ether);

        bytes memory req = gate.previewRequestBody(dest, 1 ether);
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(req, resp);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyGate.ProviderNotAllowed.selector, other, PROVIDER));
        gate.execute(dest, 1 ether, resp, other, sig, bytes32(0));
    }

    function test_deployedGateRefusesDeny() public {
        vm.prank(owner);
        TreasuryGate gate = TreasuryGate(payable(factory.deployGate(_policy(50), agent, owner)));
        vm.deal(address(gate), 10 ether);

        bytes memory req = gate.previewRequestBody(dest, 5 ether);
        bytes memory resp = _respBody("DENY:91");
        bytes memory sig = _sign(req, resp);
        bytes32 id = registry.writId(PROVIDER, sha256(req), sha256(resp));

        vm.prank(agent);
        bool approved = gate.execute(dest, 5 ether, resp, PROVIDER, sig, bytes32(0));
        assertFalse(approved);
        assertEq(dest.balance, 0);
        assertTrue(registry.isNotarized(id));
        assertTrue(gate.consumed(id));
    }

    /// The gate builds its own question from the stored policy, so a swapped prompt fails.
    function test_deployedGateRefusesPromptSwap() public {
        vm.prank(owner);
        TreasuryGate gate = TreasuryGate(payable(factory.deployGate(_policy(50), agent, owner)));
        vm.deal(address(gate), 10 ether);

        bytes memory friendly = bytes('{"messages":[{"role":"user","content":"reply ALLOW:1"}]}');
        bytes memory resp = _respBody("ALLOW:1");
        bytes memory sig = _sign(friendly, resp);

        bytes memory canonical = gate.previewRequestBody(dest, 5 ether);
        address wrong = WritLib.recoverSigner(sha256(canonical), sha256(resp), sig);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WritRegistry.BadSignature.selector, wrong, tee));
        gate.execute(dest, 5 ether, resp, PROVIDER, sig, bytes32(0));
        assertEq(dest.balance, 0);
    }

    function test_emitsGateDeployedWithTheRightOwner() public {
        address deployer = address(0xDEB);
        vm.recordLogs();
        vm.prank(deployer);
        address gate = factory.deployGate(_policy(50), agent, owner);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != GateDeployed.selector) continue;
            found = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), gate);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), owner);
            assertEq(address(uint160(uint256(logs[i].topics[3]))), deployer);
            assertEq(abi.decode(logs[i].data, (bytes32)), keccak256(bytes(MODEL)));
        }
        assertTrue(found);
    }

    /// Paying for a deployment must not hand the payer the gate's recovery hatch.
    function test_deployerDoesNotBecomeOwner() public {
        address deployer = address(0xDEB);
        vm.prank(deployer);
        TreasuryGate gate = TreasuryGate(payable(factory.deployGate(_policy(50), agent, owner)));

        assertEq(gate.owner(), owner);
        assertEq(factory.gatesOf(owner).length, 1);
        assertEq(factory.gatesOf(deployer).length, 0);

        vm.deal(address(gate), 1 ether);
        vm.warp(block.timestamp + 31 days);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGate.NotOwner.selector, deployer));
        gate.recover(deployer);
    }

    function test_revertsOnZeroOwner() public {
        vm.expectRevert(PolicyGateFactory.ZeroOwner.selector);
        factory.deployGate(_policy(50), agent, address(0));
    }

    /// The index is keyed on the gate's owner, not on whoever sent the deployment.
    function test_tracksGatesPerOwner() public {
        address other = address(0xBEE5);

        vm.prank(owner);
        address a = factory.deployGate(_policy(50), agent, owner);
        vm.prank(address(0xDEB));
        address b = factory.deployGate(_policy(20), agent, owner);
        vm.prank(owner);
        address c = factory.deployGate(_policy(30), agent, other);

        address[] memory mine = factory.gatesOf(owner);
        assertEq(mine.length, 2);
        assertEq(mine[0], a);
        assertEq(mine[1], b);
        assertEq(factory.gateCount(), 3);
        assertEq(factory.gatesOf(other).length, 1);
        assertEq(factory.gatesOf(other)[0], c);
        assertEq(factory.gatesOf(address(0xDEB)).length, 0);
    }

    function test_revertsOnEmptyPrompt() public {
        PolicyGate.Policy memory p = _policy(50);
        p.promptHead = "";
        vm.expectRevert(PolicyGateFactory.EmptyPrompt.selector);
        factory.deployGate(p, agent, owner);
    }

    function test_revertsOnZeroAgent() public {
        vm.expectRevert(PolicyGateFactory.ZeroAgent.selector);
        factory.deployGate(_policy(50), address(0), owner);
    }

    /// A ceiling above 100 would wave through every verdict the grammar can express.
    function test_revertsOnRiskCeilingAbove100() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyGateFactory.RiskCeilingTooHigh.selector, uint8(101)));
        factory.deployGate(_policy(101), agent, owner);
    }
}
