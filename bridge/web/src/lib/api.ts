export type StatusResponse = {
  eth: {
    ok: boolean;
    rpcUrl: string;
    chainId: number;
    block: number;
    bridgeAddress: string;
    wPolyxAddress: string;
    paused: boolean | null;
    nonce: string | null;
    relayer: string | null;
    wPolyxSupply: string | null;
    error?: string;
  };
  polymesh: {
    ok: boolean;
    nodeUrl: string;
    escrow: string;
    escrowBalance: string;
    error?: string;
  };
  relayer: {
    ok: boolean;
    url: string;
    detail: string;
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
    json<{ ok: true; txHash: string; sender: string; escrow: string; amountBase: string }>(
      '/api/lock',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  events: () => json<{ events: BridgeEvent[]; fromBlock: number; toBlock: number }>('/api/events'),
};
