import { BigNumber } from '@polymeshassociation/polymesh-sdk';
import { LocalSigningManager } from '@polymeshassociation/local-signing-manager';
import { Polymesh } from '@polymeshassociation/polymesh-sdk';

import { config } from '../config.js';
import { disconnectPolymesh, getEscrowAddress, getEscrowBalance } from '../polymesh.js';

/**
 * One-time setup: funds the bridge escrow account with POLYX from the dev chain's
 * well-known Alice account (//Alice, the funded sudo key on `--dev`).
 *
 * This is only needed on a fresh dev chain so that Ethereum -> Polymesh releases
 * succeed before anyone has locked POLYX in the Polymesh -> Ethereum direction.
 *
 * Usage: `yarn bootstrap`  (or `tsx src/ops/bootstrap-escrow.ts [amount]`)
 *
 * NOTE: `//Alice` only exists on the local dev chain. On testnet/mainnet you'd
 * fund the escrow from a real treasury account instead.
 */

const ALICE_MNEMONIC = '//Alice';
// Default escrow liquidity: 1,000,000 POLYX (in base units, 6 decimals).
const DEFAULT_AMOUNT = new BigNumber(1_000_000).multipliedBy(10 ** 6);

async function main(): Promise<void> {
  if (config.network === 'testnet') {
    console.error(
      '[BOOTSTRAP] Refusing to run on testnet. //Alice does not exist there.\n' +
        '  Fund the escrow manually with test POLYX:\n' +
        '    yarn addresses:testnet   # print escrow SS58\n' +
        '  See bridge/TESTNET.md',
    );
    process.exit(2);
  }

  const amountArg = process.argv[2];
  const amount = amountArg ? new BigNumber(amountArg) : DEFAULT_AMOUNT;

  // Connect as Alice to send the funding transfer.
  const aliceManager = await LocalSigningManager.create({
    accounts: [{ mnemonic: ALICE_MNEMONIC }],
  });

  const sdk = await Polymesh.connect({
    nodeUrl: config.polymesh.nodeUrl,
    middlewareV2: { link: config.polymesh.middlewareUrl, key: '' },
    polkadot: { noInitWarn: true },
  });
  await sdk.setSigningManager(aliceManager);
  const aliceAccounts = await aliceManager.getAccounts();
  sdk.setSigningAccount(aliceAccounts[0]);

  const escrow = await getEscrowAddress();
  console.log(`[BOOTSTRAP] Escrow account: ${escrow}`);

  const balanceBefore = await getEscrowBalance();
  console.log(`[BOOTSTRAP] Escrow balance before: ${balanceBefore.dividedBy(10 ** 6).toFixed(6)} POLYX`);

  if (balanceBefore.gte(amount)) {
    console.log(`[BOOTSTRAP] Escrow already funded (>= ${amount.dividedBy(10 ** 6).toFixed(0)} POLYX). Nothing to do.`);
    await sdk.disconnect();
    await disconnectPolymesh();
    return;
  }

  console.log(`[BOOTSTRAP] Funding escrow from Alice with ${amount.dividedBy(10 ** 6).toFixed(6)} POLYX...`);
  const tx = await sdk.network.transferPolyx({ to: escrow, amount, memo: 'bridge:bootstrap' });
  const hash = await tx.run();
  if (!tx.isSuccess) {
    throw new Error('Bootstrap transfer failed');
  }
  console.log(`[BOOTSTRAP] Transfer finalized. Tx hash: ${hash ?? '(none)'}`);

  const balanceAfter = await getEscrowBalance();
  console.log(`[BOOTSTRAP] Escrow balance after:  ${balanceAfter.dividedBy(10 ** 6).toFixed(6)} POLYX`);

  await sdk.disconnect();
  await disconnectPolymesh();
}

main().catch((err) => {
  console.error('[BOOTSTRAP] FAILED:', err);
  process.exit(1);
});
