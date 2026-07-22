import cors from 'cors';
import express from 'express';
import { Contract, JsonRpcProvider, formatUnits } from 'ethers';

import { ANVIL_ACCOUNTS, config } from './config.js';
import {
  disconnect,
  getEscrowAddress,
  getPolyxBalance,
  listDevAccounts,
  lockPolyx,
} from './polymesh.js';

const WPOLYX_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

const BRIDGE_ABI = [
  'function paused() view returns (bool)',
  'function nonce() view returns (uint256)',
  'function relayer() view returns (address)',
  'function wPolyx() view returns (address)',
  'event BridgedToPolymesh(uint256 indexed id, address indexed sender, string polymeshRecipient, uint256 amount)',
  'event MintedFromPolymesh(uint256 indexed id, address indexed recipient, uint256 amount)',
] as const;

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

function ethProvider(): JsonRpcProvider {
  return new JsonRpcProvider(config.eth.rpcUrl, config.eth.chainId, { staticNetwork: true });
}

async function probeRelayer(): Promise<{
  ok: boolean;
  detail: string;
  authRequired?: boolean;
  caps?: unknown;
}> {
  try {
    const res = await fetch(`${config.intentApiUrl}/health`, { method: 'GET' });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { authRequired?: boolean; caps?: unknown };
    return {
      ok: true,
      detail: 'healthy',
      authRequired: body.authRequired,
      caps: body.caps,
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

function relayerHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['content-type'] = 'application/json';
  if (config.apiToken) h.authorization = `Bearer ${config.apiToken}`;
  return h;
}

async function proxyRelayer(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${config.intentApiUrl}${path}`, { headers: relayerHeaders() });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { status: res.status, body };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/status', async (_req, res) => {
  try {
    const provider = ethProvider();
    let ethOk = false;
    let ethBlock = 0;
    let ethError: string | undefined;
    try {
      ethBlock = await provider.getBlockNumber();
      ethOk = true;
    } catch (err) {
      ethError = (err as Error).message;
    }

    let polyOk = false;
    let escrow = '';
    let escrowBalance = '0';
    let polyError: string | undefined;
    try {
      escrow = await getEscrowAddress();
      escrowBalance = await getPolyxBalance(escrow);
      polyOk = true;
    } catch (err) {
      polyError = (err as Error).message;
    }

    let bridgePaused: boolean | null = null;
    let bridgeNonce: string | null = null;
    let wPolyxSupply: string | null = null;
    let onChainRelayer: string | null = null;
    if (ethOk) {
      try {
        const bridge = new Contract(config.eth.bridgeAddress, BRIDGE_ABI, provider);
        const wpolyx = new Contract(config.eth.wPolyxAddress, WPOLYX_ABI, provider);
        const [paused, nonce, relayer, supply] = await Promise.all([
          bridge.paused() as Promise<boolean>,
          bridge.nonce() as Promise<bigint>,
          bridge.relayer() as Promise<string>,
          wpolyx.totalSupply() as Promise<bigint>,
        ]);
        bridgePaused = paused;
        bridgeNonce = nonce.toString();
        onChainRelayer = relayer;
        wPolyxSupply = supply.toString();
      } catch (err) {
        ethError = (err as Error).message;
      }
    }

    const relayer = await probeRelayer();

    res.json({
      network: config.network,
      eth: {
        ok: ethOk,
        rpcUrl: config.eth.rpcUrl,
        chainId: config.eth.chainId,
        chainName: config.eth.chainName,
        explorerUrl: config.eth.explorerUrl,
        block: ethBlock,
        bridgeAddress: config.eth.bridgeAddress,
        wPolyxAddress: config.eth.wPolyxAddress,
        paused: bridgePaused,
        nonce: bridgeNonce,
        relayer: onChainRelayer,
        wPolyxSupply,
        error: ethError,
      },
      polymesh: {
        ok: polyOk,
        nodeUrl: config.polymesh.nodeUrl,
        portalUrl: config.polymesh.portalUrl,
        escrow,
        escrowBalance,
        error: polyError,
      },
      relayer: {
        ok: relayer.ok,
        url: config.intentApiUrl,
        detail: relayer.detail,
        authRequired: relayer.authRequired ?? Boolean(config.apiToken),
      },
      caps: relayer.caps ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/caps', async (_req, res) => {
  try {
    const { status, body } = await proxyRelayer('/caps');
    res.status(status).json(body);
  } catch (err) {
    res.status(502).json({ error: `relayer unreachable: ${(err as Error).message}` });
  }
});

app.get('/api/accounts/polymesh', async (_req, res) => {
  try {
    const accounts = await listDevAccounts();
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/accounts/eth', async (_req, res) => {
  try {
    const provider = ethProvider();
    const wpolyx = new Contract(config.eth.wPolyxAddress, WPOLYX_ABI, provider);
    const accounts = await Promise.all(
      ANVIL_ACCOUNTS.map(async (acc) => {
        const [ethBal, tokenBal] = await Promise.all([
          provider.getBalance(acc.address),
          wpolyx.balanceOf(acc.address) as Promise<bigint>,
        ]);
        return {
          name: acc.name,
          address: acc.address,
          // Public Anvil keys — local demo only.
          privateKey: acc.privateKey,
          ethBalance: ethBal.toString(),
          wPolyxBalance: tokenBal.toString(),
        };
      }),
    );
    res.json({
      accounts,
      bridgeAddress: config.eth.bridgeAddress,
      wPolyxAddress: config.eth.wPolyxAddress,
      chainId: config.eth.chainId,
      rpcUrl: config.eth.rpcUrl,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/balances', async (req, res) => {
  try {
    const polyAddr = String(req.query.poly ?? '');
    const ethAddr = String(req.query.eth ?? '');
    const provider = ethProvider();
    const wpolyx = new Contract(config.eth.wPolyxAddress, WPOLYX_ABI, provider);

    const result: {
      poly?: { address: string; balance: string };
      eth?: { address: string; ethBalance: string; wPolyxBalance: string };
    } = {};

    if (polyAddr) {
      result.poly = { address: polyAddr, balance: await getPolyxBalance(polyAddr) };
    }
    if (ethAddr) {
      const [ethBalance, wPolyxBalance] = await Promise.all([
        provider.getBalance(ethAddr),
        wpolyx.balanceOf(ethAddr) as Promise<bigint>,
      ]);
      result.eth = {
        address: ethAddr,
        ethBalance: ethBalance.toString(),
        wPolyxBalance: wPolyxBalance.toString(),
      };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/lock', async (req, res) => {
  try {
    const { senderMnemonic, ethRecipient, amount } = req.body as {
      senderMnemonic?: string;
      ethRecipient?: string;
      amount?: string;
    };
    if (!senderMnemonic || !ethRecipient || !amount) {
      res.status(400).json({ error: 'senderMnemonic, ethRecipient, amount required' });
      return;
    }
    const result = await lockPolyx({
      senderMnemonic,
      ethRecipient,
      amountHuman: amount,
    });
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Proxy transfer status machine from the relayer (SQLite-backed). */
app.get('/api/transfers', async (req, res) => {
  try {
    const limit = req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : '';
    const { status, body } = await proxyRelayer(`/transfers${limit}`);
    res.status(status).json(body);
  } catch (err) {
    res.status(502).json({ error: `relayer unreachable: ${(err as Error).message}` });
  }
});

app.get('/api/transfers/:intentId', async (req, res) => {
  try {
    const { status, body } = await proxyRelayer(`/transfers/${encodeURIComponent(req.params.intentId)}`);
    res.status(status).json(body);
  } catch (err) {
    res.status(502).json({ error: `relayer unreachable: ${(err as Error).message}` });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const provider = ethProvider();
    const bridge = new Contract(config.eth.bridgeAddress, BRIDGE_ABI, provider);
    const latest = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - Number(req.query.blocks ?? 2000));

    const [burned, minted] = await Promise.all([
      bridge.queryFilter(bridge.filters.BridgedToPolymesh(), fromBlock, latest),
      bridge.queryFilter(bridge.filters.MintedFromPolymesh(), fromBlock, latest),
    ]);

    const events = [
      ...burned.map((log) => {
        const args = (log as { args: Record<string, unknown> }).args;
        return {
          type: 'BridgedToPolymesh' as const,
          id: String(args.id),
          sender: String(args.sender),
          polymeshRecipient: String(args.polymeshRecipient),
          amount: String(args.amount),
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
        };
      }),
      ...minted.map((log) => {
        const args = (log as { args: Record<string, unknown> }).args;
        return {
          type: 'MintedFromPolymesh' as const,
          id: String(args.id),
          recipient: String(args.recipient),
          amount: String(args.amount),
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
        };
      }),
    ].sort((a, b) => b.blockNumber - a.blockNumber);

    res.json({ fromBlock, toBlock: latest, events });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Helpful for UI display without client-side format deps mismatches
app.get('/api/format-hint', (_req, res) => {
  res.json({
    decimals: 6,
    example: formatUnits(1_000_000n, 6),
  });
});

const server = app.listen(config.port, () => {
  console.log(`[web-api] listening on http://127.0.0.1:${config.port}`);
  console.log(`[web-api] eth=${config.eth.rpcUrl} bridge=${config.eth.bridgeAddress}`);
  console.log(`[web-api] polymesh=${config.polymesh.nodeUrl}`);
  console.log(`[web-api] relayer intent=${config.intentApiUrl}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
