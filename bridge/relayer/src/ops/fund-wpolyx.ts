/**
 * Demo faucet: lock POLYX so the relayer mints wPOLYX to an Ethereum address
 * (typically MetaMask). Local default sender is //Bob.
 *
 * Usage:
 *   yarn faucet:wpolyx 0xYourMetaMask [amountPolyx] [senderMnemonic]
 *
 * Requires running relayer. On testnet pass a real funded mnemonic (not //Bob).
 */

import { BigNumber } from '@polymeshassociation/polymesh-sdk';
import { LocalSigningManager } from '@polymeshassociation/local-signing-manager';
import { Polymesh } from '@polymeshassociation/polymesh-sdk';

import { config } from '../config.js';
import { disconnectPolymesh, getEscrowAddress } from '../polymesh.js';

const INTENT_API = process.env.BRIDGE_INTENT_API_URL ?? `http://127.0.0.1:${config.intentApiPort}`;
const API_TOKEN = process.env.BRIDGE_API_TOKEN ?? 'dev-bridge-token';

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (API_TOKEN && API_TOKEN.toLowerCase() !== 'off' && API_TOKEN.toLowerCase() !== 'none') {
    h.authorization = `Bearer ${API_TOKEN}`;
  }
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitCompleted(intentId: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${INTENT_API}/transfers/${intentId}`, { headers: authHeaders() });
    if (res.ok) {
      const body = (await res.json()) as { transfer: { status: string; error?: string | null } };
      console.log(`[FAUCET] status=${body.transfer.status}`);
      if (body.transfer.status === 'completed') return;
      if (body.transfer.status === 'failed') {
        throw new Error(`mint failed: ${body.transfer.error ?? 'unknown'}`);
      }
    }
    await sleep(3000);
  }
  throw new Error(`timeout waiting for intent ${intentId}`);
}

async function main(): Promise<void> {
  const [ethRecipient, amountArg, senderMnemonic] = process.argv.slice(2);
  if (!ethRecipient) {
    console.error('Usage: yarn faucet:wpolyx <ethAddress> [amountPolyx] [senderMnemonic]');
    console.error('  e.g. yarn faucet:wpolyx 0xYourMetaMask 10 //Bob');
    process.exit(2);
  }
  if (!ethRecipient.startsWith('0x') || ethRecipient.length !== 42) {
    throw new Error(`Invalid Ethereum address: ${ethRecipient}`);
  }

  const amountHuman = amountArg ?? '10';
  const senderKey = senderMnemonic ?? '//Bob';
  const amountBase = new BigNumber(amountHuman).multipliedBy(10 ** 6);
  if (!amountBase.isInteger() || amountBase.lte(0)) {
    throw new Error(`Invalid amount: ${amountHuman}`);
  }

  if (config.network === 'testnet' && senderKey.startsWith('//')) {
    throw new Error(
      'On testnet pass a funded Polymesh mnemonic, not //Bob. Example:\n' +
        '  yarn faucet:wpolyx 0xYou 5 "word1 word2 …"',
    );
  }

  try {
    const h = await fetch(`${INTENT_API}/health`);
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
  } catch (err) {
    throw new Error(
      `Relayer unreachable at ${INTENT_API}. Run: yarn start  (${(err as Error).message})`,
    );
  }

  console.log(`[FAUCET] network=${config.network} amount=${amountHuman} → ${ethRecipient}`);

  const senderManager = await LocalSigningManager.create({
    accounts: [{ mnemonic: senderKey }],
  });
  const sdk = await Polymesh.connect({
    nodeUrl: config.polymesh.nodeUrl,
    middlewareV2: { link: config.polymesh.middlewareUrl, key: '' },
    polkadot: { noInitWarn: true },
  });

  try {
    await sdk.setSigningManager(senderManager);
    const accounts = await senderManager.getAccounts();
    const sender = accounts[0];
    sdk.setSigningAccount(sender);
    const escrow = await getEscrowAddress();

    const intentResp = await fetch(`${INTENT_API}/lock-intent`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        polySender: sender,
        ethRecipient,
        amount: amountBase.toFixed(0),
      }),
    });
    if (!intentResp.ok) {
      throw new Error(`intent API ${intentResp.status}: ${await intentResp.text()}`);
    }
    const intentJson = (await intentResp.json()) as { intentId: string; memo: string };
    console.log(`[FAUCET] intentId=${intentJson.intentId} memo=${intentJson.memo}`);

    const tx = await sdk.network.transferPolyx({
      to: escrow,
      amount: amountBase,
      memo: intentJson.memo,
    });
    await tx.run();
    if (!tx.isSuccess) throw new Error('lock transfer failed');
    console.log(`[FAUCET] POLYX locked. Waiting for relayer mint…`);

    await waitCompleted(intentJson.intentId);

    console.log('');
    console.log('[FAUCET] DONE — wPOLYX minted to your Ethereum address.');
    console.log('[FAUCET] MetaMask setup:');
    console.log(`  Network: ${config.eth.chainName}`);
    console.log(`  RPC:     ${config.eth.rpcUrl}`);
    console.log(`  ChainId: ${config.eth.chainId}`);
    console.log(`  Token:   ${config.eth.wPolyxAddress}  (symbol wPOLYX, decimals 6)`);
    console.log('[FAUCET] Then in the UI: MetaMask → Bridge → To Polymesh → burn.');
  } finally {
    await sdk.disconnect();
    await disconnectPolymesh();
  }
}

main().catch((err) => {
  console.error('[FAUCET] FAILED:', err);
  process.exit(1);
});
