import { BrowserProvider, Contract, JsonRpcProvider, Wallet, parseUnits, type Signer } from 'ethers';

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

/** Sign with a local Anvil private key (demo mode — no MetaMask required). */
export function signerFromPrivateKey(privateKey: string, rpcUrl: string, chainId: number): Wallet {
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  return new Wallet(privateKey, provider);
}

/** Optional MetaMask path. */
export async function signerFromMetaMask(): Promise<{ signer: Signer; address: string }> {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error('MetaMask not found');
  const provider = new BrowserProvider(eth as never);
  await provider.send('eth_requestAccounts', []);
  const signer = await provider.getSigner();
  return { signer, address: await signer.getAddress() };
}

export async function getWpolyxBalance(
  address: string,
  cfg: EthConfig,
): Promise<bigint> {
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
  const token = new Contract(cfg.wPolyxAddress, WPOLYX_ABI, provider);
  return (await token.balanceOf(address)) as bigint;
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
