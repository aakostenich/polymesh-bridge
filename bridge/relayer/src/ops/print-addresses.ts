/**
 * Print bridge-related addresses from the current env (local or testnet).
 *
 * Usage:
 *   yarn addresses
 *   BRIDGE_NETWORK=testnet yarn addresses
 */

import { Wallet, JsonRpcProvider, formatEther } from 'ethers';

import { config } from '../config.js';
import { disconnectPolymesh, getEscrowAddress, getEscrowBalance } from '../polymesh.js';

async function main(): Promise<void> {
  console.log(`[ADDR] network=${config.network}`);
  console.log(`[ADDR] eth.rpc=${config.eth.rpcUrl}`);
  console.log(`[ADDR] eth.chainId=${config.eth.chainId} (${config.eth.chainName})`);
  console.log(`[ADDR] polymesh.node=${config.polymesh.nodeUrl}`);

  const wallet = new Wallet(config.eth.relayerPrivateKey);
  console.log(`[ADDR] eth.relayerKeyAddress=${wallet.address}`);
  console.log(`[ADDR] eth.bridge=${config.eth.bridgeAddress}`);
  console.log(`[ADDR] eth.wPolyx=${config.eth.wPolyxAddress}`);

  try {
    const provider = new JsonRpcProvider(config.eth.rpcUrl, config.eth.chainId, {
      staticNetwork: true,
    });
    const bal = await provider.getBalance(wallet.address);
    console.log(`[ADDR] eth.relayerBalance=${formatEther(bal)} ETH`);
    const chainId = (await provider.getNetwork()).chainId;
    console.log(`[ADDR] eth.rpcChainId=${chainId.toString()}`);
  } catch (err) {
    console.log(`[ADDR] eth.rpc ERROR: ${(err as Error).message}`);
  }

  try {
    const escrow = await getEscrowAddress();
    const bal = await getEscrowBalance();
    console.log(`[ADDR] poly.escrow=${escrow}`);
    console.log(`[ADDR] poly.escrowBalance=${bal.dividedBy(10 ** 6).toFixed(6)} POLYX`);
    if (config.polymesh.portalUrl) {
      console.log(`[ADDR] poly.portal=${config.polymesh.portalUrl}`);
    }
    if (config.polymesh.explorerUrl) {
      console.log(`[ADDR] poly.explorer=${config.polymesh.explorerUrl}account/${escrow}`);
    }
  } catch (err) {
    console.log(`[ADDR] poly ERROR: ${(err as Error).message}`);
  }

  if (config.eth.explorerUrl) {
    console.log(`[ADDR] eth.explorer.bridge=${config.eth.explorerUrl}/address/${config.eth.bridgeAddress}`);
    console.log(`[ADDR] eth.explorer.wpolyx=${config.eth.explorerUrl}/token/${config.eth.wPolyxAddress}`);
  }

  console.log('');
  console.log('[ADDR] Fund escrow with test POLYX to this SS58 address for Eth→Poly releases.');
  console.log('[ADDR] Fund eth.relayerKeyAddress with Sepolia ETH for mint gas.');
}

main()
  .catch((err) => {
    console.error('[ADDR] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPolymesh();
  });
