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
 * Flow:
 *   1. POST /lock-intent → relayer returns intentId + memo (`b:<intentId>`)
 *   2. transferPolyx to escrow with that memo
 *   3. Relayer matches by memo intent id (SQLite-backed, restart-safe)
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

  const amountBase = new BigNumber(amountArg).multipliedBy(10 ** 6);
  if (!amountBase.isInteger() || amountBase.lte(0)) {
    throw new Error(`Invalid amount: ${amountArg} (must be a positive number with <= 6 decimals)`);
  }

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

  const intentApiBase = process.env.BRIDGE_INTENT_API_URL ?? 'http://127.0.0.1:3006';
  const intentApiUrl = `${intentApiBase}/lock-intent`;
  const apiToken = process.env.BRIDGE_API_TOKEN ?? 'dev-bridge-token';
  console.log(`[LOCK] registering intent with relayer at ${intentApiUrl}...`);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiToken && apiToken.toLowerCase() !== 'off' && apiToken.toLowerCase() !== 'none') {
    headers.authorization = `Bearer ${apiToken}`;
  }
  const intentResp = await fetch(intentApiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      polySender: sender,
      ethRecipient,
      amount: amountBase.toFixed(0),
    }),
  });
  if (!intentResp.ok) {
    throw new Error(`Intent registration failed: ${intentResp.status} ${await intentResp.text()}`);
  }
  const intentJson = (await intentResp.json()) as {
    intentId: string;
    memo: string;
    status: string;
  };
  console.log(`[LOCK] intentId=${intentJson.intentId} memo=${intentJson.memo} status=${intentJson.status}`);

  // Carry the short intent id on-chain in the 32-byte memo.
  const tx = await sdk.network.transferPolyx({
    to: escrow,
    amount: amountBase,
    memo: intentJson.memo,
  });
  await tx.run();
  if (!tx.isSuccess) {
    throw new Error('Lock transfer failed');
  }

  console.log(`[LOCK] transfer finalized. Tx hash: ${tx.txHash ?? '(none)'}`);
  console.log(`[LOCK] Track status: GET ${intentApiBase}/transfers/${intentJson.intentId}`);
  console.log('[LOCK] Relayer will mint wPOLYX once the block is finalized.');

  await sdk.disconnect();
  await disconnectPolymesh();
}

main().catch((err) => {
  console.error('[LOCK] FAILED:', err);
  process.exit(1);
});
