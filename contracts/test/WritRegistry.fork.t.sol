// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {WritRegistry} from "../src/WritRegistry.sol";
import {IInferenceServing} from "../src/interfaces/IInferenceServing.sol";

/// @notice Runs against live 0G mainnet state. Read-only: spends nothing.
/// @dev Provider addresses were read from the registry on 2026-08-26. If a provider changes
///      its registration, list the current set with
///      `cast call 0x47340d900bdFec2BD393c626E12ea0656F938d84
///       "getAllServices(uint256,uint256)((address,string,string,uint256,uint256,uint256,string,string,string,address,bool)[],uint256)"
///       0 50 --rpc-url https://evmrpc.0g.ai` and pick another acknowledged TeeML chatbot.
contract WritRegistryForkTest is Test {
    address constant SERVING = 0x47340d900bdFec2BD393c626E12ea0656F938d84;

    // Live acknowledged TeeML chatbot service (model 0GM-1.0-35B-A3B).
    address constant TEE_PROVIDER = 0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9;
    // Live service that 0G serves WITHOUT a TEE (verifiability == "standard").
    address constant NON_TEE_PROVIDER = 0xd3f02c1a04160389d98D2192AE2034159f731011;

    WritRegistry registry;

    function setUp() public {
        vm.createSelectFork("zg");
        registry = new WritRegistry(SERVING);
    }

    function test_liveTeeProviderIsAcknowledgedAndTeeML() public view {
        IInferenceServing.Service memory s = IInferenceServing(SERVING).getService(TEE_PROVIDER);
        assertEq(keccak256(bytes(s.verifiability)), keccak256(bytes("TeeML")));
        assertTrue(s.teeSignerAcknowledged);
        assertTrue(s.teeSignerAddress != address(0));
        console.log("model:", s.model);
        console.log("tee signer:", s.teeSignerAddress);
    }

    function test_rejectsLiveNonTeeProvider() public {
        IInferenceServing.Service memory s = IInferenceServing(SERVING).getService(NON_TEE_PROVIDER);
        assertTrue(keccak256(bytes(s.verifiability)) != keccak256(bytes("TeeML")));
        vm.expectRevert(
            abi.encodeWithSelector(WritRegistry.NotTeeVerifiable.selector, NON_TEE_PROVIDER, s.verifiability)
        );
        registry.notarize(NON_TEE_PROVIDER, bytes32(uint256(1)), bytes32(uint256(2)), hex"00", bytes32(0));
    }

    function test_rejectsGarbageSignatureForLiveTeeProvider() public {
        // 65-byte signature that recovers to something, but never the registered TEE signer.
        bytes memory junk = hex"1111111111111111111111111111111111111111111111111111111111111111"
            hex"2222222222222222222222222222222222222222222222222222222222222222" hex"1b";
        vm.expectRevert();
        registry.notarize(TEE_PROVIDER, bytes32(uint256(1)), bytes32(uint256(2)), junk, bytes32(0));
    }

    /// The live registry reverts `ServiceNotExist` rather than returning an empty service, so a
    /// proof naming a provider 0G has never seen cannot be notarized.
    function test_rejectsUnregisteredProvider() public {
        address ghost = address(0xC0FFEE);
        vm.expectRevert(abi.encodeWithSelector(IInferenceServing.ServiceNotExist.selector, ghost));
        registry.notarize(ghost, bytes32(uint256(1)), bytes32(uint256(2)), hex"00", bytes32(0));
    }
}
