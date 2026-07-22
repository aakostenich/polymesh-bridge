export type StatusWarning = {
  code: string;
  level: 'warn' | 'error';
  message: string;
};

export type StatusResponse = {
  network?: string;
  eth: {
    ok: boolean;
    rpcUrl: string;
    chainId: number;
    chainName?: string;
    explorerUrl?: string | null;
    block: number;
    bridgeAddress: string;
    wPolyxAddress: string;
    paused: boolean | null;
    nonce: string | null;
    relayer: string | null;
    relayerKeyAddress?: string | null;
    relayerEthBalance?: string | null;
    wPolyxSupply: string | null;
    error?: string;
  };
  polymesh: {
    ok: boolean;
    nodeUrl: string;
    portalUrl?: string | null;
    explorerUrl?: string | null;
    escrow: string;
    escrowBalance: string;
    error?: string;
  };
  relayer: {
    ok: boolean;
    url: string;
    detail: string;
    authRequired?: boolean;
  };
  caps?: {
    minAmount: string;
    maxAmount: string;
    dailyVolume: string;
    dailyUsed: string;
    minPolyx: string;
    maxPolyx: string;
    dailyVolumePolyx: string;
    dailyUsedPolyx: string;
  } | null;
  warnings?: StatusWarning[];
  explorers?: {
    ethBridge?: string | null;
    ethWpolyx?: string | null;
    ethTxPrefix?: string | null;
    polyEscrow?: string | null;
    polyPortal?: string | null;
  };
};

export type PolyAccount = {
  name: string;
  mnemonic: string;
  role: string;
  address: string;
  balance: string;
  isEscrow: boolean;
};

export type EthAccount = {
  name: string;
  address: string;
  privateKey: string;
  ethBalance: string;
  wPolyxBalance: string;
};

export type BridgeEvent =
  | {
      type: 'BridgedToPolymesh';
      id: string;
      sender: string;
      polymeshRecipient: string;
      amount: string;
      blockNumber: number;
      txHash: string;
    }
  | {
      type: 'MintedFromPolymesh';
      id: string;
      recipient: string;
      amount: string;
      blockNumber: number;
      txHash: string;
    };

export type TransferStatus =
  | 'intent_registered'
  | 'locked'
  | 'awaiting_finality'
  | 'relaying'
  | 'completed'
  | 'failed';

export type TransferRecord = {
  intentId: string;
  direction: 'eth_to_poly' | 'poly_to_eth';
  status: TransferStatus;
  polySender: string | null;
  ethRecipient: string | null;
  polymeshRecipient: string | null;
  amount: string;
  polyBlock: number | null;
  ethTxHash: string | null;
  polyTxHash: string | null;
  relayedTxHash: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export const api = {
  status: () => json<StatusResponse>('/api/status'),
  polyAccounts: () => json<{ accounts: PolyAccount[] }>('/api/accounts/polymesh'),
  ethAccounts: () =>
    json<{
      accounts: EthAccount[];
      bridgeAddress: string;
      wPolyxAddress: string;
      chainId: number;
      rpcUrl: string;
    }>('/api/accounts/eth'),
  lock: (body: { senderMnemonic: string; ethRecipient: string; amount: string }) =>
    json<{
      ok: true;
      txHash: string;
      sender: string;
      escrow: string;
      amountBase: string;
      intentId: string;
      memo: string;
      status: string;
    }>('/api/lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  events: () => json<{ events: BridgeEvent[]; fromBlock: number; toBlock: number }>('/api/events'),
  transfers: (limit = 50) =>
    json<{ transfers: TransferRecord[] }>(`/api/transfers?limit=${limit}`).catch(() => ({
      transfers: [] as TransferRecord[],
    })),
  transfer: (intentId: string) =>
    json<{ transfer: TransferRecord; memo?: string }>(`/api/transfers/${intentId}`),
};
