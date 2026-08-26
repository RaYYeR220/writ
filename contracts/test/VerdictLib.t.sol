// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerdictLib} from "../src/VerdictLib.sol";
import {VerdictLibHarness} from "./harness/VerdictLibHarness.sol";

contract VerdictLibTest is Test {
    VerdictLibHarness lib;

    function setUp() public {
        lib = new VerdictLibHarness();
    }

    function _body(string memory content) internal pure returns (bytes memory) {
        return abi.encodePacked('{"id":"c1","choices":[{"message":{"role":"assistant","content":"', content, '"}}]}');
    }

    function test_parsesAllow() public view {
        (bool allowed, uint8 risk) = lib.parseVerdict(_body("ALLOW:12"));
        assertTrue(allowed);
        assertEq(risk, 12);
    }

    function test_parsesDeny() public view {
        (bool allowed, uint8 risk) = lib.parseVerdict(_body("DENY:87"));
        assertFalse(allowed);
        assertEq(risk, 87);
    }

    function test_parsesSingleDigitAndHundred() public view {
        (bool a, uint8 r) = lib.parseVerdict(_body("ALLOW:0"));
        assertTrue(a);
        assertEq(r, 0);
        (a, r) = lib.parseVerdict(_body("DENY:100"));
        assertFalse(a);
        assertEq(r, 100);
    }

    function test_revertsWhenMarkerMissing() public {
        vm.expectRevert(VerdictLib.MarkerNotFound.selector);
        lib.parseVerdict(bytes('{"error":"nope"}'));
    }

    function test_revertsOnUnknownKeyword() public {
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        lib.parseVerdict(_body("MAYBE:50"));
    }

    function test_revertsOnMissingRisk() public {
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        lib.parseVerdict(_body("ALLOW:"));
    }

    function test_revertsOnNonNumericRisk() public {
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        lib.parseVerdict(_body("ALLOW:1x"));
    }

    function test_revertsOnRiskAbove100() public {
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        lib.parseVerdict(_body("ALLOW:101"));
    }

    function test_revertsOnProseAroundVerdict() public {
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        lib.parseVerdict(_body("Sure! ALLOW:10"));
    }

    function test_revertsOnTrailingProse() public {
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        lib.parseVerdict(_body("ALLOW:10 because it looks fine"));
    }

    function test_revertsOnLowercaseKeyword() public {
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        lib.parseVerdict(_body("allow:10"));
    }

    function test_revertsWhenContentExceedsCap() public {
        string memory long = "ALLOW:1234567890123456789012345678901234567890";
        vm.expectRevert(VerdictLib.VerdictTooLong.selector);
        lib.parseVerdict(_body(long));
    }

    function test_revertsOnUnterminatedContent() public {
        vm.expectRevert(VerdictLib.VerdictMalformed.selector);
        lib.parseVerdict(bytes('{"content":"ALLOW:1'));
    }
}
