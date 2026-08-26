// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {PolicyGateFactory} from "../src/PolicyGateFactory.sol";
import {AgentTreasury} from "../src/examples/AgentTreasury.sol";
import {MockInferenceServing} from "./mocks/MockInferenceServing.sol";

/// @dev Runs the deploy script against a mock registry. Nothing is broadcast: without
///      `--broadcast` a script's transactions are simulated and thrown away.
///
///      The deployment is driven through `deploy(Config)` rather than `run()`. Environment
///      variables are host process state shared by every test in the run, so a suite that set
///      them per test would race with itself; exactly one test below reads the environment.
contract DeployTest is Test {
    uint256 constant DEPLOYER_PK = 0xD1E;
    address constant PROVIDER = address(0xBEEF);
    address constant AGENT = address(0xA9);
    address constant OWNER = address(0x0FE);
    string constant MODEL = "0GM-1.0-35B-A3B";

    MockInferenceServing serving;
    Deploy deployScript;

    function setUp() public {
        serving = new MockInferenceServing();
        serving.set(PROVIDER, MODEL, "TeeML", address(0x7EE), true);
        deployScript = new Deploy();
    }

    function _config() internal view returns (Deploy.Config memory) {
        return Deploy.Config({
            serving: address(serving),
            provider: PROVIDER,
            agent: AGENT,
            owner: OWNER,
            maxRisk: 50,
            deployerKey: DEPLOYER_PK
        });
    }

    function test_deploysTheWholeStackWiredTogether() public {
        (WritRegistry registry, PolicyGateFactory factory, AgentTreasury treasury) = deployScript.deploy(_config());

        assertEq(address(registry.serving()), address(serving));
        assertEq(address(factory.registry()), address(registry));
        assertEq(address(treasury.registry()), address(registry));
        assertEq(treasury.agent(), AGENT);
        assertEq(treasury.owner(), OWNER);
    }

    /// The model hash comes from what 0G's registry reports the provider serves, never from a
    /// constant in the script: a gate pinned to a stale model name would refuse every proof.
    function test_wiresTheModelHashFromTheLiveProvider() public {
        (,, AgentTreasury treasury) = deployScript.deploy(_config());
        assertEq(treasury.getPolicy(treasury.POLICY_ID()).allowedModelHash, keccak256(bytes(MODEL)));
        assertEq(treasury.getPolicy(treasury.POLICY_ID()).allowedProvider, PROVIDER);
        assertEq(treasury.getPolicy(treasury.POLICY_ID()).maxRisk, 50);
    }

    /// A provider 0G does not vouch for cannot produce a proof this gate would ever accept, so
    /// deploying against one is the mistake worth blocking outright rather than logging.
    function test_refusesAProviderWhoseSignerIsNotAcknowledged() public {
        serving.set(PROVIDER, MODEL, "TeeML", address(0x7EE), false);
        vm.expectRevert(abi.encodeWithSelector(Deploy.SignerNotAcknowledged.selector, PROVIDER));
        deployScript.deploy(_config());
    }

    function test_refusesAProviderThatIsNotTeeML() public {
        serving.set(PROVIDER, MODEL, "standard", address(0x7EE), true);
        vm.expectRevert(abi.encodeWithSelector(Deploy.NotTeeVerifiable.selector, PROVIDER, "standard"));
        deployScript.deploy(_config());
    }

    /// The check runs before the broadcast, so a bad provider costs nothing.
    function test_refusesAProviderTheRegistryHasNeverSeen() public {
        Deploy.Config memory c = _config();
        c.provider = address(0xC0FFEE);
        vm.expectRevert();
        deployScript.deploy(c);
    }

    /// A ceiling above 100 waves through every verdict the grammar can express.
    function test_refusesARiskCeilingAbove100() public {
        Deploy.Config memory c = _config();
        c.maxRisk = 101;
        vm.expectRevert(abi.encodeWithSelector(Deploy.RiskCeilingTooHigh.selector, uint256(101)));
        deployScript.deploy(c);
    }

    function test_refusesAZeroAgent() public {
        Deploy.Config memory c = _config();
        c.agent = address(0);
        vm.expectRevert(Deploy.ZeroAgent.selector);
        deployScript.deploy(c);
    }

    function test_refusesAZeroOwner() public {
        Deploy.Config memory c = _config();
        c.owner = address(0);
        vm.expectRevert(Deploy.ZeroOwner.selector);
        deployScript.deploy(c);
    }

    /// Every variable `.env.example` documents is one the script actually reads.
    function test_readsEveryConfiguredValueFromTheEnvironment() public {
        vm.setEnv("INFERENCE_SERVING", vm.toString(address(serving)));
        vm.setEnv("TEE_PROVIDER", vm.toString(PROVIDER));
        vm.setEnv("AGENT_ADDRESS", vm.toString(AGENT));
        vm.setEnv("OWNER_ADDRESS", vm.toString(OWNER));
        vm.setEnv("MAX_RISK", "42");
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_PK));

        Deploy.Config memory c = deployScript.config();
        assertEq(c.serving, address(serving));
        assertEq(c.provider, PROVIDER);
        assertEq(c.agent, AGENT);
        assertEq(c.owner, OWNER);
        assertEq(c.maxRisk, 42);
        assertEq(c.deployerKey, DEPLOYER_PK);
    }
}
