// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {WritLib} from "../src/WritLib.sol";
import {WritLibHarness} from "./harness/WritLibHarness.sol";

/// @dev Constants come from `script/gen-fixtures.mjs` run with key 0x11..11; rerun it to reproduce.
contract WritLibTest is Test {
    bytes32 constant REQ_H = 0xccdfb98dd427a783eb317f4d7a5170c4677d7c3f8f087b5413ca0f0eade91c88;
    bytes32 constant RESP_H = 0xf0219cdd97103db1958d11c92a595576441f6620b2debc86a980892700e73608;
    bytes constant SIG =
        hex"45a0f6fdfb75a69764265ac9539e979398f6584b48e031cb7dd5b298829f78780dc8f223289452f22fd25b64c51e5da821fdafdef59e021794038c302865ca4d1b";
    address constant SIGNER = 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A;

    // Centralized routing proof over the same request/response pair, same key.
    string constant P_TYPE = "centralized";
    string constant P_IDENTITY = "openrouter";
    bytes32 constant TLS_FP = 0x67038b7d0b458b9d2e2e8a3451709f84bdcad46a71a36fe82bd7bdb266df2537;
    bytes constant ROUTING_SIG =
        hex"6af690cde50dc856c6a8d024219aa0843eb3c9c90c287f0b59b90173f5a326a564b3208392697ac4a3744220a6f7bb39729d36274510bdf33a704e6422dfb3e31c";

    function test_signedTextIs129BytesAndMatchesBroker() public pure {
        bytes memory t = WritLib.signedText(REQ_H, RESP_H);
        assertEq(t.length, 129);
        assertEq(
            string(t),
            "ccdfb98dd427a783eb317f4d7a5170c4677d7c3f8f087b5413ca0f0eade91c88:f0219cdd97103db1958d11c92a595576441f6620b2debc86a980892700e73608"
        );
    }

    function test_recoversTeeSigner() public pure {
        assertEq(WritLib.recoverSigner(REQ_H, RESP_H, SIG), SIGNER);
    }

    function test_tamperedResponseDoesNotRecoverSigner() public pure {
        assertTrue(WritLib.recoverSigner(REQ_H, bytes32(uint256(RESP_H) + 1), SIG) != SIGNER);
    }

    function test_tamperedRequestDoesNotRecoverSigner() public pure {
        assertTrue(WritLib.recoverSigner(bytes32(uint256(REQ_H) + 1), RESP_H, SIG) != SIGNER);
    }

    function test_sha256PrecompileBindsRawResponseBytes() public pure {
        bytes memory raw = bytes('{"id":"chat-1","choices":[{"message":{"content":"DENY:87"}}]}');
        assertEq(sha256(raw), RESP_H);
    }

    function test_sha256PrecompileBindsRawRequestBytes() public pure {
        bytes memory raw = bytes('{"model":"0GM-1.0-35B-A3B","messages":[{"role":"user","content":"POLICY-TEST"}]}');
        assertEq(sha256(raw), REQ_H);
    }

    /// Records the cost of one complete proof verification: rebuild the signed text, apply the
    /// EIP-191 prefix, and recover the signer.
    function test_measuresVerificationGas() public {
        WritLibHarness h = new WritLibHarness();
        uint256 before = gasleft();
        address signer = h.recoverSigner(REQ_H, RESP_H, SIG);
        uint256 used = before - gasleft();
        assertEq(signer, SIGNER);
        console.log("recoverSigner gas:", used);
        assertLt(used, 100_000);
    }

    function test_routingProofTextMatchesBrokerFormat() public pure {
        bytes memory t = WritLib.routingProofText(REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP);
        assertEq(t.length, 217);
        assertEq(
            string(t),
            "ccdfb98dd427a783eb317f4d7a5170c4677d7c3f8f087b5413ca0f0eade91c88:f0219cdd97103db1958d11c92a595576441f6620b2debc86a980892700e73608:centralized:openrouter:67038b7d0b458b9d2e2e8a3451709f84bdcad46a71a36fe82bd7bdb266df2537"
        );
    }

    function test_recoversRoutingProofSigner() public pure {
        assertEq(WritLib.recoverRoutingProofSigner(REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG), SIGNER);
    }

    /// The routing text is variable length, so the EIP-191 prefix must carry the real decimal
    /// length. This is the one place a hand-rolled prefix would silently have been wrong.
    function test_routingProofPrefixCarriesTheDecimalLength() public pure {
        bytes memory t = WritLib.routingProofText(REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP);
        (bytes32 r, bytes32 s, uint8 v) = _split(ROUTING_SIG);

        bytes32 right = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n217", t));
        assertEq(ecrecover(right, v, r, s), SIGNER);

        bytes32 wrong = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n129", t));
        assertTrue(ecrecover(wrong, v, r, s) != SIGNER);
    }

    /// The two formats are not interchangeable, in either direction.
    function test_theTwoSignedTextFormatsDoNotCrossVerify() public pure {
        assertTrue(WritLib.recoverSigner(REQ_H, RESP_H, ROUTING_SIG) != SIGNER);
        assertTrue(WritLib.recoverRoutingProofSigner(REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, SIG) != SIGNER);
    }

    function test_routingProofTextBindsEveryField() public pure {
        bytes memory base = WritLib.routingProofText(REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP);
        assertTrue(
            keccak256(base) != keccak256(WritLib.routingProofText(REQ_H, RESP_H, "decentralized", P_IDENTITY, TLS_FP))
        );
        assertTrue(keccak256(base) != keccak256(WritLib.routingProofText(REQ_H, RESP_H, P_TYPE, "aliyun", TLS_FP)));
        assertTrue(
            keccak256(base)
                != keccak256(WritLib.routingProofText(REQ_H, RESP_H, P_TYPE, P_IDENTITY, bytes32(uint256(TLS_FP) + 1)))
        );
    }

    /// A routing proof binds three more fields, so it should cost a little more to verify.
    function test_measuresRoutingProofVerificationGas() public {
        WritLibHarness h = new WritLibHarness();
        uint256 before = gasleft();
        address signer = h.recoverRoutingProofSigner(REQ_H, RESP_H, P_TYPE, P_IDENTITY, TLS_FP, ROUTING_SIG);
        uint256 used = before - gasleft();
        assertEq(signer, SIGNER);
        console.log("recoverRoutingProofSigner gas:", used);
        assertLt(used, 120_000);
    }

    function _split(bytes memory sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }

    function test_hex64IsLowercaseAndZeroPadded() public pure {
        assertEq(
            string(WritLib.hex64(bytes32(uint256(0x0a)))),
            "000000000000000000000000000000000000000000000000000000000000000a"
        );
    }
}
