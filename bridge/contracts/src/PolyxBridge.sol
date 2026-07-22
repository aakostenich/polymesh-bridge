// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {WrappedPolyx} from "./WrappedPolyx.sol";

/// @title PolyxBridge
/// @notice Two-way bridge router between native POLYX (Polymesh) and wPOLYX (this chain).
///
/// @dev Escrow / lock-mint model. The bridge holds no POLYX itself — POLYX is
///      held in a separate Polymesh escrow account managed off-chain by the
///      relayer. This contract only governs the wPOLYX side:
///
///      Ethereum -> Polymesh:  user calls `bridgeToPolymesh`, which burns their
///                             wPOLYX and emits an event the relayer picks up to
///                             release POLYX from escrow on Polymesh.
///
///      Polymesh -> Ethereum:  after POLYX is locked in escrow on Polymesh, the
///                             relayer calls `mintFromPolymesh`, which mints
///                             wPOLYX to the intended recipient.
///
///      Trust model (MVP): a single trusted relayer address is authorized to
///      mint. This is clearly marked as an MVP; production upgrades to M-of-N
///      validator sets (see README). Replay protection is on-chain via
///      `processedNonces` for the mint direction and a monotonic `nonce` for the
///      burn direction; the relayer additionally de-duplicates off-chain.
contract PolyxBridge {
    WrappedPolyx public immutable wPolyx;

    /// @dev Polymesh SS58 addresses are 48 characters.
    uint256 private constant POLYMESH_ADDRESS_LENGTH = 48;

    address public owner;
    address public relayer;

    bool public paused;

    /// @dev Monotonic counter for `BridgedToPolymesh` events (replay protection
    ///      on the Ethereum->Polymesh direction).
    uint256 public nonce;

    /// @dev Poly event ids that have already triggered a mint. Prevents the
    ///      relayer (or a compromised one) from double-crediting.
    mapping(uint256 => bool) public processedNonces;

    event BridgedToPolymesh(
        uint256 indexed id, address indexed sender, string polymeshRecipient, uint256 amount
    );
    event MintedFromPolymesh(uint256 indexed id, address indexed recipient, uint256 amount);
    event RelayerChanged(address indexed previousRelayer, address indexed newRelayer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address account);
    event Unpaused(address account);

    modifier onlyOwner() {
        require(msg.sender == owner, "PolyxBridge: not owner");
        _;
    }

    modifier onlyRelayer() {
        require(msg.sender == relayer, "PolyxBridge: not relayer");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "PolyxBridge: paused");
        _;
    }

    constructor(address _wPolyx, address _relayer) {
        require(_wPolyx != address(0), "PolyxBridge: zero wPolyx");
        require(_relayer != address(0), "PolyxBridge: zero relayer");
        wPolyx = WrappedPolyx(_wPolyx);
        owner = msg.sender;
        relayer = _relayer;
        emit OwnershipTransferred(address(0), msg.sender);
        emit RelayerChanged(address(0), _relayer);
    }

    // ---------------------------------------------------------------------------
    // Ethereum -> Polymesh (user burns wPOLYX to get POLYX back)
    // ---------------------------------------------------------------------------

    /// @notice Bridge wPOLYX back to native POLYX on Polymesh.
    /// @param polymeshRecipient Polymesh SS58 address (48 chars) to receive POLYX.
    /// @param amount Amount of wPOLYX to burn (6 decimals).
    /// @dev Requires the bridge to have allowance to burn the caller's tokens,
    ///      or the caller may approve `type(uint256).max` for convenience.
    function bridgeToPolymesh(string calldata polymeshRecipient, uint256 amount) external whenNotPaused {
        require(bytes(polymeshRecipient).length == POLYMESH_ADDRESS_LENGTH, "PolyxBridge: bad recipient length");
        require(amount > 0, "PolyxBridge: zero amount");

        // Burn the caller's wPOLYX. This reduces supply 1:1 with the POLYX being
        // released from escrow on Polymesh.
        wPolyx.burnFrom(msg.sender, amount);

        uint256 id = ++nonce;
        emit BridgedToPolymesh(id, msg.sender, polymeshRecipient, amount);
    }

    // ---------------------------------------------------------------------------
    // Polymesh -> Ethereum (relayer mints wPOLYX after POLYX is locked)
    // ---------------------------------------------------------------------------

    /// @notice Mint wPOLYX to a recipient, crediting POLYX locked on Polymesh.
    /// @param ethRecipient Ethereum address to receive the minted wPOLYX.
    /// @param amount Amount to mint (6 decimals).
    /// @param polyEventId Unique id of the Polymesh lock event (replay key).
    /// @dev Only the trusted relayer may call this. `polyEventId` is checked
    ///      against `processedNonces` so a given Polymesh lock is credited once.
    function mintFromPolymesh(address ethRecipient, uint256 amount, uint256 polyEventId)
        external
        onlyRelayer
        whenNotPaused
    {
        require(ethRecipient != address(0), "PolyxBridge: zero recipient");
        require(amount > 0, "PolyxBridge: zero amount");
        require(!processedNonces[polyEventId], "PolyxBridge: nonce already processed");

        processedNonces[polyEventId] = true;
        wPolyx.mint(ethRecipient, amount);

        emit MintedFromPolymesh(polyEventId, ethRecipient, amount);
    }

    // ---------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------

    function setRelayer(address _relayer) external onlyOwner {
        require(_relayer != address(0), "PolyxBridge: zero relayer");
        emit RelayerChanged(relayer, _relayer);
        relayer = _relayer;
    }

    function transferOwnership(address _owner) external onlyOwner {
        require(_owner != address(0), "PolyxBridge: zero owner");
        emit OwnershipTransferred(owner, _owner);
        owner = _owner;
    }

    function pause() external onlyOwner {
        require(!paused, "PolyxBridge: already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        require(paused, "PolyxBridge: not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }
}
