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

    function test_hex64IsLowercaseAndZeroPadded() public pure {
        assertEq(
            string(WritLib.hex64(bytes32(uint256(0x0a)))),
            "000000000000000000000000000000000000000000000000000000000000000a"
        );
    }
}
