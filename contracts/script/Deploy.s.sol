// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {PolicyGateFactory} from "../src/PolicyGateFactory.sol";
import {AgentTreasury} from "../src/examples/AgentTreasury.sol";
import {PromptLib} from "../src/PromptLib.sol";
import {IInferenceServing} from "../src/interfaces/IInferenceServing.sol";

/// @title Deploy
/// @notice Deploys the registry, the gate factory and one reference treasury.
/// @dev Everything is configured from the environment; see `.env.example`. Mainnet is chain
///      16661, RPC `https://evmrpc.0g.ai`, and 0G's InferenceServing lives at
///      `0x47340d900bdFec2BD393c626E12ea0656F938d84`.
///
///      Dry run first, which costs nothing and touches nothing:
///        `forge script script/Deploy.s.sol --fork-url https://evmrpc.0g.ai`
///      Add `--broadcast` only when the deployer is funded and the dry run reads right.
///
///      The provider is checked BEFORE the broadcast. A gate pointed at a provider that cannot
///      produce verifiable proofs is not a degraded deployment, it is a dead one: no proof it
///      ever sees will notarize, so the treasury is bricked from birth and the only way out is
///      the 30-day hatch. That is worth failing loudly on rather than logging a warning about.
contract Deploy is Script {
    /// @dev 0G marks a TEE service with this exact `verifiability` string.
    bytes32 private constant TEE_ML = keccak256(bytes("TeeML"));

    error SignerNotAcknowledged(address provider);
    error NotTeeVerifiable(address provider, string verifiability);
    error RiskCeilingTooHigh(uint256 maxRisk);
    error ZeroAgent();
    error ZeroOwner();

    struct Config {
        address serving;
        address provider;
        address agent;
        address owner;
        uint256 maxRisk;
        uint256 deployerKey;
    }

    function run() external returns (WritRegistry registry, PolicyGateFactory factory, AgentTreasury treasury) {
        return deploy(config());
    }

    /// @notice Reads every setting from the environment. A missing variable aborts here, before
    ///         anything is deployed.
    function config() public view returns (Config memory c) {
        c.serving = vm.envAddress("INFERENCE_SERVING");
        c.provider = vm.envAddress("TEE_PROVIDER");
        c.agent = vm.envAddress("AGENT_ADDRESS");
        c.owner = vm.envAddress("OWNER_ADDRESS");
        c.maxRisk = vm.envUint("MAX_RISK");
        c.deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
    }

    /// @notice Checks the provider, then deploys the three contracts and logs what it made.
    /// @dev Public rather than private so the deployment can be driven from a test without
    ///      going through the process environment.
    function deploy(Config memory c)
        public
        returns (WritRegistry registry, PolicyGateFactory factory, AgentTreasury treasury)
    {
        if (c.agent == address(0)) revert ZeroAgent();
        if (c.owner == address(0)) revert ZeroOwner();
        if (c.maxRisk > 100) revert RiskCeilingTooHigh(c.maxRisk);

        // Read 0G's live registry before spending anything. It reverts for a provider it has
        // never seen, which is the right answer too.
        IInferenceServing.Service memory svc = IInferenceServing(c.serving).getService(c.provider);
        if (!svc.teeSignerAcknowledged) revert SignerNotAcknowledged(c.provider);
        if (keccak256(bytes(svc.verifiability)) != TEE_ML) revert NotTeeVerifiable(c.provider, svc.verifiability);

        console.log("InferenceServing: ", c.serving);
        console.log("provider:         ", c.provider);
        console.log("model:            ", svc.model);
        console.log("tee signer:       ", svc.teeSignerAddress);

        // The treasury is pinned to the model 0G reports this provider serving, not to a constant
        // written here: a stale name would refuse every proof the provider produces. That one
        // name becomes both halves of the gate — the `"model"` key in the question and
        // `allowedModelHash` — so there is no second argument left to disagree with it, and no
        // deploy-time check needed to reconcile them.
        //
        // The name still has to survive being spliced into JSON. The constructor enforces that
        // itself; this repeats the check ahead of the broadcast so a provider with an unusable
        // name costs nothing rather than reverting on the third of three deployments.
        PromptLib.requireModelName(svc.model);

        vm.startBroadcast(c.deployerKey);
        registry = new WritRegistry(c.serving);
        factory = new PolicyGateFactory(registry);
        // forge-lint: disable-next-line(unsafe-typecast)
        treasury = new AgentTreasury(registry, c.agent, c.owner, svc.model, c.provider, uint8(c.maxRisk));
        vm.stopBroadcast();

        console.log("WritRegistry:     ", address(registry));
        console.log("PolicyGateFactory:", address(factory));
        console.log("AgentTreasury:    ", address(treasury));
        console.log("  agent:          ", c.agent);
        console.log("  owner:          ", c.owner);
        console.log("  maxRisk:        ", c.maxRisk);
    }
}
