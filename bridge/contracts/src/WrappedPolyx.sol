// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title WrappedPolyx
/// @notice ERC-20 representation of Polymesh's native POLYX on Ethereum.
/// @dev 6 decimals to match POLYX 1:1 (no decimal conversion needed at the
///      bridge boundary, unlike the legacy POLY->POLYX bridge which had to
///      truncate 18->6 decimals). Supply starts at zero and grows/shrinks with
///      bridge traffic: minted when POLYX is locked on Polymesh, burned when
///      wPOLYX is bridged back.
///
///      Minting is restricted to a single minter (the bridge contract). Burning
///      is permissionless: holders burn their own tokens to bridge back, and the
///      bridge burns on behalf of an approved spender.
contract WrappedPolyx {
    /// @dev ERC-20 decimals matching POLYX (6).
    uint8 public constant decimals = 6;

    string public name;
    string public symbol;

    uint256 public totalSupply;

    address public minter;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterChanged(address indexed previousMinter, address indexed newMinter);

    modifier onlyMinter() {
        require(msg.sender == minter, "WrappedPolyx: not minter");
        _;
    }

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
        minter = msg.sender;
        emit MinterChanged(address(0), msg.sender);
    }

    /// @notice Transfer the minter role to a new address (e.g. the bridge).
    function setMinter(address _minter) external onlyMinter {
        require(_minter != address(0), "WrappedPolyx: zero minter");
        emit MinterChanged(minter, _minter);
        minter = _minter;
    }

    /// @notice Mint tokens to a recipient. Only callable by the minter (bridge).
    function mint(address to, uint256 amount) external onlyMinter {
        require(to != address(0), "WrappedPolyx: mint to zero");
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn the caller's own tokens (used to bridge back to Polymesh).
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Burn tokens on behalf of an owner, requires allowance.
    /// @dev Used by the bridge in `bridgeToPolymesh`.
    function burnFrom(address owner, uint256 amount) external {
        uint256 allowed = allowance[owner][msg.sender];
        require(allowed >= amount, "WrappedPolyx: insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[owner][msg.sender] = allowed - amount;
        }
        _burn(owner, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "WrappedPolyx: insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0), "WrappedPolyx: transfer from zero");
        require(to != address(0), "WrappedPolyx: transfer to zero");
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= amount, "WrappedPolyx: insufficient balance");
        unchecked {
            balanceOf[from] = fromBalance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        require(from != address(0), "WrappedPolyx: burn from zero");
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= amount, "WrappedPolyx: burn exceeds balance");
        unchecked {
            balanceOf[from] = fromBalance - amount;
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }
}
