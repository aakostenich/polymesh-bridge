import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  Wallet,
  parseUnits,
  type Eip1193Provider,
  type Signer,
} from 'ethers';

const WPOLYX_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
] as const;

const BRIDGE_ABI = [
  'function bridgeToPolymesh(string polymeshRecipient, uint256 amount)',
  'function paused() view returns (bool)',
] as const;

export type EthConfig = {
  rpcUrl: string;
  chainId: number;
  bridgeAddress: string;
  wPolyxAddress: string;
  chainName?: string;
  explorerUrl?: string | null;
};

export function formatPolyx(baseUnits: string | bigint, digits = 6): string {
  const n = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits || '0');
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 10n ** BigInt(digits);
  const frac = (abs % 10n ** BigInt(digits)).toString().padStart(digits, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function parsePolyx(human: string): bigint {
  return parseUnits(human, 6);
}

export function shortAddr(addr: string, n = 4): string {
  if (!addr) return '—';
  if (addr.length <= n * 2 + 2) return addr;
  return `${addr.slice(0, 2 + n)}…${addr.slice(-n)}`;
}

function getEthereum(): Eip1193Provider {
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!eth) throw new Error('MetaMask not found. Install MetaMask or use Demo accounts.');
  return eth;
}

export function hasMetaMask(): boolean {
  return Boolean((window as unknown as { ethereum?: unknown }).ethereum);
}

/** Sign with a local Anvil private key (demo mode — no MetaMask required). */
export function signerFromPrivateKey(privateKey: string, rpcUrl: string, chainId: number): Wallet {
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  return new Wallet(privateKey, provider);
}

/**
 * Ensure MetaMask is on the bridge chain (Anvil local or Sepolia).
 * Adds the network if missing.
 */
export async function ensureBridgeNetwork(cfg: EthConfig): Promise<void> {
  const eth = getEthereum();
  const chainIdHex = `0x${cfg.chainId.toString(16)}`;
  const chainName =
    cfg.chainName ??
    (cfg.chainId === 11155111 ? 'Sepolia' : cfg.chainId === 1337 ? 'Anvil Local (POLYX Bridge)' : `Chain ${cfg.chainId}`);
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 4902 = chain not added
    if (code === 4902 || code === -32603) {
      const params: Record<string, unknown> = {
        chainId: chainIdHex,
        chainName,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [cfg.rpcUrl],
      };
      if (cfg.explorerUrl) {
        params.blockExplorerUrls = [cfg.explorerUrl];
      }
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [params],
      });
      return;
    }
    throw err;
  }
}

/** @deprecated use ensureBridgeNetwork */
export async function ensureAnvilNetwork(cfg: EthConfig): Promise<void> {
  return ensureBridgeNetwork(cfg);
}

/** Connect MetaMask, switch to bridge network, return signer + address. */
export async function connectMetaMask(
  cfg: EthConfig,
): Promise<{ signer: Signer; address: string; provider: BrowserProvider }> {
  const eth = getEthereum();
  const provider = new BrowserProvider(eth);
  await provider.send('eth_requestAccounts', []);
  await ensureBridgeNetwork(cfg);
  // Re-create after chain switch so network is correct.
  const provider2 = new BrowserProvider(eth);
  const signer = await provider2.getSigner();
  const address = await signer.getAddress();
  return { signer, address, provider: provider2 };
}

export async function getWpolyxBalance(address: string, cfg: EthConfig): Promise<bigint> {
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
  const token = new Contract(cfg.wPolyxAddress, WPOLYX_ABI, provider);
  return (await token.balanceOf(address)) as bigint;
}

/** Prompt MetaMask to track wPOLYX (ERC-20, 6 decimals). */
export async function watchWpolyxToken(cfg: EthConfig): Promise<boolean> {
  const eth = getEthereum();
  try {
    const ok = await eth.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC20',
        options: {
          address: cfg.wPolyxAddress,
          symbol: 'wPOLYX',
          decimals: 6,
        },
      },
    });
    return Boolean(ok);
  } catch {
    return false;
  }
}

/**
 * Ethereum → Polymesh: approve (if needed) then bridgeToPolymesh.
 */
export async function bridgeToPolymesh(
  signer: Signer,
  cfg: EthConfig,
  polymeshRecipient: string,
  amountHuman: string,
): Promise<string> {
  if (polymeshRecipient.length !== 48) {
    throw new Error('Polymesh SS58 address must be exactly 48 characters');
  }
  const amount = parsePolyx(amountHuman);
  if (amount <= 0n) throw new Error('Amount must be > 0');

  const token = new Contract(cfg.wPolyxAddress, WPOLYX_ABI, signer);
  const bridge = new Contract(cfg.bridgeAddress, BRIDGE_ABI, signer);
  const owner = await signer.getAddress();

  const allowance = (await token.allowance(owner, cfg.bridgeAddress)) as bigint;
  if (allowance < amount) {
    const approveTx = await token.approve(cfg.bridgeAddress, amount);
    await approveTx.wait();
  }

  const tx = await bridge.bridgeToPolymesh(polymeshRecipient, amount);
  const receipt = await tx.wait();
  if (!receipt) throw new Error('No receipt for bridgeToPolymesh');
  return receipt.hash as string;
}
