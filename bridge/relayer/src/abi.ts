/**
 * Minimal ABI for the bridge contracts — only the functions and events the
 * relayer needs. Kept inline so the relayer doesn't depend on the compiled
 * Foundry artifacts at runtime.
 *
 * Source of truth: bridge/contracts/src/PolyxBridge.sol
 */
export const bridgeAbi = [
  // --- functions ---
  'function mintFromPolymesh(address ethRecipient, uint256 amount, uint256 polyEventId) external',
  'function nonce() view returns (uint256)',
  'function relayer() view returns (address)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function processedNonces(uint256) view returns (bool)',
  // --- events ---
  {
    type: 'event',
    name: 'BridgedToPolymesh',
    inputs: [
      { indexed: true, name: 'id', type: 'uint256' },
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: false, name: 'polymeshRecipient', type: 'string' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'MintedFromPolymesh',
    inputs: [
      { indexed: true, name: 'id', type: 'uint256' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
] as const;
