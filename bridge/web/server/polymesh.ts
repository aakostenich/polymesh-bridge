import { LocalSigningManager } from '@polymeshassociation/local-signing-manager';
import { BigNumber, Polymesh } from '@polymeshassociation/polymesh-sdk';

import { config, POLYMESH_DEV_ACCOUNTS } from './config.js';

let _sdk: Polymesh | undefined;
let _escrowAddress: string | undefined;
const addressByMnemonic = new Map<string, string>();

async function ensureConnected(): Promise<Polymesh> {
  if (_sdk) return _sdk;

  const accounts: Array<{ mnemonic: string }> = POLYMESH_DEV_ACCOUNTS.map((a) => ({
    mnemonic: a.mnemonic,
  }));
  if (!accounts.some((a) => a.mnemonic === config.polymesh.escrowMnemonic)) {
    accounts.push({ mnemonic: config.polymesh.escrowMnemonic });
  }

  const manager = await LocalSigningManager.create({ accounts });
  const sdk = await Polymesh.connect({
    nodeUrl: config.polymesh.nodeUrl,
    middlewareV2: { link: config.polymesh.middlewareUrl, key: '' },
    polkadot: { noInitWarn: true },
  });

  await sdk.setSigningManager(manager);
  const resolved = await manager.getAccounts();

  for (let i = 0; i < accounts.length; i++) {
    if (resolved[i]) addressByMnemonic.set(accounts[i].mnemonic, resolved[i]);
  }

  _escrowAddress = addressByMnemonic.get(config.polymesh.escrowMnemonic) ?? resolved[0];
  if (!_escrowAddress) throw new Error('Failed to resolve escrow address');
  sdk.setSigningAccount(_escrowAddress);

  _sdk = sdk;
  return sdk;
}

export async function getEscrowAddress(): Promise<string> {
  if (!_escrowAddress) await ensureConnected();
  return _escrowAddress!;
}

export async function resolveMnemonicAddress(mnemonic: string): Promise<string> {
  await ensureConnected();
  const addr = addressByMnemonic.get(mnemonic);
  if (!addr) throw new Error(`Unknown mnemonic (not in dev account set): ${mnemonic}`);
  return addr;
}

export async function getPolyxBalance(address: string): Promise<string> {
  const sdk = await ensureConnected();
  const account = await sdk.accountManagement.getAccount({ address });
  const balance = await account.getBalance();
  return balance.free.toFixed(0);
}

export async function listDevAccounts(): Promise<
  Array<{
    name: string;
    mnemonic: string;
    role: string;
    address: string;
    balance: string;
    isEscrow: boolean;
  }>
> {
  const escrow = await getEscrowAddress();
  const out = [];
  for (const acc of POLYMESH_DEV_ACCOUNTS) {
    const address = await resolveMnemonicAddress(acc.mnemonic);
    const balance = await getPolyxBalance(address);
    out.push({
      name: acc.name,
      mnemonic: acc.mnemonic,
      role: acc.role,
      address,
      balance,
      isEscrow: address === escrow,
    });
  }
  return out;
}

export async function lockPolyx(params: {
  senderMnemonic: string;
  ethRecipient: string;
  amountHuman: string;
}): Promise<{
  txHash: string;
  sender: string;
  escrow: string;
  amountBase: string;
  intentId: string;
  memo: string;
  status: string;
}> {
  const { senderMnemonic, ethRecipient, amountHuman } = params;

  if (!ethRecipient.startsWith('0x') || ethRecipient.length !== 42) {
    throw new Error(`Invalid Ethereum address: ${ethRecipient}`);
  }

  const amountBase = new BigNumber(amountHuman).multipliedBy(10 ** 6);
  if (!amountBase.isInteger() || amountBase.lte(0)) {
    throw new Error(`Invalid amount: ${amountHuman}`);
  }

  const senderManager = await LocalSigningManager.create({
    accounts: [{ mnemonic: senderMnemonic }],
  });
  const sdk = await Polymesh.connect({
    nodeUrl: config.polymesh.nodeUrl,
    middlewareV2: { link: config.polymesh.middlewareUrl, key: '' },
    polkadot: { noInitWarn: true },
  });

  try {
    await sdk.setSigningManager(senderManager);
    const senderAccounts = await senderManager.getAccounts();
    const sender = senderAccounts[0];
    sdk.setSigningAccount(sender);

    const escrow = await getEscrowAddress();

    const intentUrl = `${config.intentApiUrl}/lock-intent`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiToken) headers.authorization = `Bearer ${config.apiToken}`;
    const intentResp = await fetch(intentUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        polySender: sender,
        ethRecipient,
        amount: amountBase.toFixed(0),
      }),
    });
    if (!intentResp.ok) {
      const text = await intentResp.text();
      throw new Error(
        `Relayer intent API failed (${intentResp.status}): ${text}. Is the relayer running on ${config.intentApiUrl}?`,
      );
    }
    const intentJson = (await intentResp.json()) as {
      intentId: string;
      memo: string;
      status: string;
    };

    const tx = await sdk.network.transferPolyx({
      to: escrow,
      amount: amountBase,
      memo: intentJson.memo,
    });
    await tx.run();
    if (!tx.isSuccess) {
      throw new Error('Lock transfer failed on Polymesh');
    }

    return {
      txHash: String(tx.txHash ?? ''),
      sender,
      escrow,
      amountBase: amountBase.toFixed(0),
      intentId: intentJson.intentId,
      memo: intentJson.memo,
      status: intentJson.status,
    };
  } finally {
    await sdk.disconnect();
  }
}

export async function disconnect(): Promise<void> {
  if (_sdk) {
    await _sdk.disconnect();
    _sdk = undefined;
    _escrowAddress = undefined;
    addressByMnemonic.clear();
  }
}
