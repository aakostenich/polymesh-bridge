// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {WrappedPolyx} from "../src/WrappedPolyx.sol";
import {PolyxBridge} from "../src/PolyxBridge.sol";

/// @notice Unit tests for the POLYX<->wPOLYX bridge contracts.
/// Run with: forge test --match-contract PolyxBridgeTest
contract PolyxBridgeTest is Test {
    WrappedPolyx internal wPolyx;
    PolyxBridge internal bridge;

    // Polymesh SS58 addresses are 48 chars (substrate prefix 42). These are the
    // well-known dev-chain Alice/Bob addresses, which is what the relayer escrow
    // and signers actually use on the local chain.
    string internal constant POLY_ADDR = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"; // Alice
    string internal constant POLY_ADDR_2 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"; // Bob

    address internal owner = address(this);
    address internal relayer = address(0xBEEF);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        wPolyx = new WrappedPolyx("Wrapped POLYX", "wPOLYX");
        bridge = new PolyxBridge(address(wPolyx), relayer);

        // Hand the minter role from this contract (deployer) to the bridge.
        wPolyx.setMinter(address(bridge));
    }

    // ---- WrappedPolyx basics ------------------------------------------------

    function testDecimals() public view {
        assertEq(wPolyx.decimals(), 6);
        assertEq(wPolyx.name(), "Wrapped POLYX");
        assertEq(wPolyx.symbol(), "wPOLYX");
    }

    function testInitialSupplyZero() public view {
        assertEq(wPolyx.totalSupply(), 0);
    }

    function testCannotMintDirectly() public {
        // After setMinter(bridge), only the bridge can mint; this (owner) cannot.
        vm.expectRevert("WrappedPolyx: not minter");
        wPolyx.mint(alice, 100);
    }

    // ---- Polymesh -> Ethereum (mint) ----------------------------------------

    function testMintFromPolymesh() public {
        vm.prank(relayer);
        bridge.mintFromPolymesh(alice, 1_000_000, 1);

        assertEq(wPolyx.balanceOf(alice), 1_000_000);
        assertEq(wPolyx.totalSupply(), 1_000_000);
        assertTrue(bridge.processedNonces(1));
    }

    function testMintReplayProtection() public {
        vm.startPrank(relayer);
        bridge.mintFromPolymesh(alice, 1_000_000, 42);

        // Same polyEventId must not be credited twice.
        vm.expectRevert("PolyxBridge: nonce already processed");
        bridge.mintFromPolymesh(alice, 1_000_000, 42);
        vm.stopPrank();
    }

    function testMintOnlyRelayer() public {
        vm.prank(alice);
        vm.expectRevert("PolyxBridge: not relayer");
        bridge.mintFromPolymesh(alice, 1_000_000, 1);
    }

    function testMintZeroRecipientRejected() public {
        vm.prank(relayer);
        vm.expectRevert("PolyxBridge: zero recipient");
        bridge.mintFromPolymesh(address(0), 1_000_000, 1);
    }

    function testMintZeroAmountRejected() public {
        vm.prank(relayer);
        vm.expectRevert("PolyxBridge: zero amount");
        bridge.mintFromPolymesh(alice, 0, 1);
    }

    function testMintNonceAdvancesIndependently() public {
        // Different polyEventIds are independent; both should mint.
        vm.startPrank(relayer);
        bridge.mintFromPolymesh(alice, 500, 1);
        bridge.mintFromPolymesh(alice, 500, 2);
        vm.stopPrank();

        assertEq(wPolyx.balanceOf(alice), 1_000);
    }

    // ---- Ethereum -> Polymesh (burn) ----------------------------------------

    function _fundAlice(uint256 amount) internal {
        vm.prank(relayer);
        bridge.mintFromPolymesh(alice, amount, 1);
    }

    function testBridgeToPolymeshBurnsAndEmits() public {
        _fundAlice(1_000_000);

        // Alice approves the bridge, then bridges back.
        vm.startPrank(alice);
        wPolyx.approve(address(bridge), 1_000_000);

        vm.expectEmit(true, true, false, true);
        emit PolyxBridge.BridgedToPolymesh(1, alice, POLY_ADDR, 1_000_000);

        bridge.bridgeToPolymesh(POLY_ADDR, 1_000_000);
        vm.stopPrank();

        assertEq(wPolyx.balanceOf(alice), 0);
        assertEq(wPolyx.totalSupply(), 0);
        assertEq(bridge.nonce(), 1);
    }

    function testBridgeRevertsWithoutAllowance() public {
        _fundAlice(1_000_000);
        vm.prank(alice);
        vm.expectRevert("WrappedPolyx: insufficient allowance");
        bridge.bridgeToPolymesh(POLY_ADDR, 1_000_000);
    }

    function testBridgeRejectsBadRecipientLength() public {
        _fundAlice(1_000_000);
        vm.startPrank(alice);
        wPolyx.approve(address(bridge), 1_000_000);

        vm.expectRevert("PolyxBridge: bad recipient length");
        bridge.bridgeToPolymesh("too short", 1_000_000);
        vm.stopPrank();
    }

    function testBridgeRejectsZeroAmount() public {
        _fundAlice(1_000_000);
        vm.prank(alice);
        wPolyx.approve(address(bridge), type(uint256).max);

        vm.expectRevert("PolyxBridge: zero amount");
        bridge.bridgeToPolymesh(POLY_ADDR, 0);
    }

    function testBridgeNonceIncrementsPerCall() public {
        _fundAlice(2_000_000);
        vm.startPrank(alice);
        wPolyx.approve(address(bridge), type(uint256).max);

        bridge.bridgeToPolymesh(POLY_ADDR, 1_000_000);
        bridge.bridgeToPolymesh(POLY_ADDR_2, 1_000_000);
        vm.stopPrank();

        assertEq(bridge.nonce(), 2);
    }

    // ---- Full round trip ----------------------------------------------------

    function testFullRoundTrip() public {
        // 1. POLYX locked on Polymesh -> mint wPOLYX to Alice.
        vm.prank(relayer);
        bridge.mintFromPolymesh(alice, 5_000_000, 100);
        assertEq(wPolyx.balanceOf(alice), 5_000_000);

        // 2. Alice bridges back -> burns wPOLYX, emits event for POLYX release.
        vm.startPrank(alice);
        wPolyx.approve(address(bridge), 5_000_000);
        bridge.bridgeToPolymesh(POLY_ADDR, 5_000_000);
        vm.stopPrank();

        assertEq(wPolyx.balanceOf(alice), 0);
        assertEq(wPolyx.totalSupply(), 0);

        // 3. A different lock mints again (supply is elastic).
        vm.prank(relayer);
        bridge.mintFromPolymesh(bob, 3_000_000, 101);
        assertEq(wPolyx.balanceOf(bob), 3_000_000);
    }

    // ---- Pause / admin ------------------------------------------------------

    function testPauseBlocksBothDirections() public {
        bridge.pause();
        assertTrue(bridge.paused());

        // Eth->Poly blocked.
        vm.prank(alice);
        vm.expectRevert("PolyxBridge: paused");
        bridge.bridgeToPolymesh(POLY_ADDR, 1);

        // Poly->Eth blocked.
        vm.prank(relayer);
        vm.expectRevert("PolyxBridge: paused");
        bridge.mintFromPolymesh(alice, 1, 1);
    }

    function testUnpauseRestores() public {
        bridge.pause();
        bridge.unpause();
        assertFalse(bridge.paused());

        vm.prank(relayer);
        bridge.mintFromPolymesh(alice, 1, 1);
        assertEq(wPolyx.balanceOf(alice), 1);
    }

    function testOnlyOwnerCanPause() public {
        vm.prank(alice);
        vm.expectRevert("PolyxBridge: not owner");
        bridge.pause();
    }

    function testSetRelayer() public {
        address newRelayer = address(0xCAFE);
        bridge.setRelayer(newRelayer);
        assertEq(bridge.relayer(), newRelayer);

        // Old relayer can no longer mint.
        vm.prank(relayer);
        vm.expectRevert("PolyxBridge: not relayer");
        bridge.mintFromPolymesh(alice, 1, 1);

        // New relayer can.
        vm.prank(newRelayer);
        bridge.mintFromPolymesh(alice, 1, 1);
    }

    function testTransferOwnership() public {
        address newOwner = address(0xD0D);
        bridge.transferOwnership(newOwner);
        assertEq(bridge.owner(), newOwner);

        // Old owner lost control.
        vm.expectRevert("PolyxBridge: not owner");
        bridge.pause();
    }

    function testCannotSetZeroRelayer() public {
        vm.expectRevert("PolyxBridge: zero relayer");
        bridge.setRelayer(address(0));
    }

    function testCannotSetZeroOwner() public {
        vm.expectRevert("PolyxBridge: zero owner");
        bridge.transferOwnership(address(0));
    }
}
