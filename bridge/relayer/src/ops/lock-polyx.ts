import { BigNumber } from '@polymeshassociation/polymesh-sdk';
import { LocalSigningManager } from '@polymeshassociation/local-signing-manager';
import { Polymesh } from '@polymeshassociation/polymesh-sdk';

import { config } from '../config.js';
import { disconnectPolymesh, getEscrowAddress } from '../polymesh.js';

/**
 * User CLI: lock POLYX into the escrow to bridge it to Ethereum (as wPOLYX).
 *
 * Usage:
 *   yarn lock <senderMnemonic> <ethRecipient> <amountPolyx>
 *
 *   senderMnemonic  Mnemonic of the Polymesh account sending POLYX (e.g. //Bob).
 *   ethRecipient    Ethereum address to receive minted wPOLYX.
 *   amountPolyx     Human-readable POLYX amount (e.g. "12.5"), converted to base units.
 *
 * This performs a plain `transferPolyx` to the escrow. The relayer matches the
 * incoming transfer to a pending intent registered by this script (see README
 * for the MVP binding limitation).
 *
 * NOTE: for the relayer to bind the transfer to the eth recipient, run this
 * script while the relayer is running and pointed at the same escrow, OR set
 * the intent via the relayer's registration mechanism beforehand. The simplest
 * local flow: start the relayer, then run this script — the smoke test wires
 * both together.
 */

async function main(): Promise<void> {
  const [senderMnemonic, ethRecipient, amountArg] = process.argv.slice(2);
  if (!senderMnemonic || !ethRecipient || !amountArg) {
    console.error('Usage: yarn lock <senderMnemonic> <ethRecipient> <amountPolyx>');
    console.error('  e.g. yarn lock //Bob 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 12.5');
    process.exit(2);
  }

  if (!ethRecipient.startsWith('0x') || ethRecipient.length !== 42) {
    throw new Error(`Invalid Ethereum address: ${ethRecipient}`);
  }

  // Human POLYX -> base units (6 decimals).
  const amountBase = new BigNumber(amountArg).multipliedBy(10 ** 6);
  if (!amountBase.isInteger() || amountBase.lte(0)) {
    throw new Error(`Invalid amount: ${amountArg} (must be a positive number with <= 6 decimals)`);
  }

  // Connect as the sender (not the escrow).
  const senderManager = await LocalSigningManager.create({
    accounts: [{ mnemonic: senderMnemonic }],
  });
  const sdk = await Polymesh.connect({
    nodeUrl: config.polymesh.nodeUrl,
    middlewareV2: { link: config.polymesh.middlewareUrl, key: '' },
    polkadot: { noInitWarn: true },
  });
  await sdk.setSigningManager(senderManager);
  const senderAccounts = await senderManager.getAccounts();
  sdk.setSigningAccount(senderAccounts[0]);
  const sender = senderAccounts[0];

  const escrow = await getEscrowAddress();
  console.log(`[LOCK] sender:    ${sender}`);
  console.log(`[LOCK] escrow:    ${escrow}`);
  console.log(`[LOCK] eth recv:  ${ethRecipient}`);
  console.log(`[LOCK] amount:    ${amountArg} POLYX (${amountBase.toFixed()} base units)`);

  // Register a pending intent with the running relayer so it can bind this
  // transfer to the Ethereum recipient. The relayer matches by (sender, amount).
  const intentApiUrl = `${process.env.BRIDGE_INTENT_API_URL ?? 'http://127.0.0.1:3006'}/lock-intent`;
  console.log(`[LOCK] registering intent with relayer at ${intentApiUrl}...`);
  const intentResp = await fetch(intentApiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      polySender: sender,
      ethRecipient,
      amount: amountBase.toFixed(),
    }),
  });
  if (!intentResp.ok) {
    throw new Error(`Intent registration failed: ${intentResp.status} ${await intentResp.text()}`);
  }
  console.log('[LOCK] intent registered with relayer.');

  // Note: the eth recipient is NOT carried in the memo here because Polymesh
  // limits memo to 32 bytes — too short for a full Ethereum address. The
  // relayer learns the recipient via the intent API above. A production bridge
  // would instead use a settlement instruction with metadata, or a short
  // lookup id in the memo mapped to the full address off-chain.
  const tx = await sdk.network.transferPolyx({
    to: escrow,
    amount: amountBase,
  });
  const hash = await tx.run();
  if (!tx.isSuccess) {
    throw new Error('Lock transfer failed');
  }

  console.log(`[LOCK] transfer finalized. Tx hash: ${hash ?? '(none)'}`);
  console.log('[LOCK] The relayer will mint wPOLYX once the block is finalized.');

  await sdk.disconnect();
  await disconnectPolymesh();
}

main().catch((err) => {
  console.error('[LOCK] FAILED:', err);
  process.exit(1);
});
