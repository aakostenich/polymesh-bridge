// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {WrappedPolyx} from "../src/WrappedPolyx.sol";
import {PolyxBridge} from "../src/PolyxBridge.sol";

/// @notice Deploys WrappedPolyx and PolyxBridge to the configured chain.
/// @dev The relayer address is read from the `RELAYER_ADDRESS` env var (defaults
///      to Anvil account #1, the second funded account, so deployer != relayer).
///      Run: forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
contract Deploy is Script {
    // Default to Anvil's account[1] if RELAYER_ADDRESS is not provided.
    // (account[0] is used as the deployer / bridge owner.)
    address internal constant DEFAULT_RELAYER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    function run() external returns (WrappedPolyx wPolyx, PolyxBridge bridge) {
        address relayer = vm.envOr("RELAYER_ADDRESS", DEFAULT_RELAYER);

        vm.startBroadcast();

        wPolyx = new WrappedPolyx("Wrapped POLYX", "wPOLYX");
        bridge = new PolyxBridge(address(wPolyx), relayer);

        // Transfer the wPOLYX minter role from deployer to the bridge contract.
        wPolyx.setMinter(address(bridge));

        vm.stopBroadcast();

        // Emit so `forge script` output and scripts can scrape the addresses.
        // forge-pretty-ignore-next-line
        console.log("WPOLYX_ADDRESS=", address(wPolyx));
        // forge-pretty-ignore-next-line
        console.log("BRIDGE_ADDRESS=", address(bridge));
        console.log("RELAYER_ADDRESS=", relayer);
        console.log("OWNER=", msg.sender);
    }
}
