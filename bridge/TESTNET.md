# Testnet guide: Polymesh Testnet × Ethereum Sepolia

This guide takes the bridge from **local Anvil / docker-compose** to **public testnets** so you can:

1. Get **test POLYX** and **Sepolia ETH**
2. Deploy **wPOLYX + PolyxBridge** on Sepolia
3. Run the **relayer** against real RPCs
4. Complete a first lock/mint and burn/release

> Still an MVP (single trusted relayer). Use only throwaway keys. Never mainnet funds.

---

## Architecture on testnet

| Leg | Network | Endpoint (public) |
|-----|---------|-------------------|
| Native POLYX | Polymesh **Testnet** | `wss://testnet-rpc.polymesh.live/` |
| Indexer | Polymesh GraphQL | `https://testnet-graphql.polymesh.live/` |
| Portal | Polymesh | https://portal.polymesh.live/ |
| Explorer | Subscan | https://polymesh-testnet.subscan.io/ |
| wPOLYX / bridge | **Ethereum Sepolia** | chain id `11155111` |
| Eth explorer | Etherscan | https://sepolia.etherscan.io |

Local Anvil (`1337`) remains available via `bridge/envs/local.env`.

---

## 1. Get test tokens

### A. Sepolia ETH (gas + deploy)

1. Install **MetaMask** and create / unlock a wallet.
2. Enable test networks (Settings → Advanced → Show test networks).
3. Switch to **Sepolia**.
4. Request ETH from a faucet (any that works for you):
   - [Chainlink Sepolia faucet](https://faucets.chain.link/sepolia) (~0.5 ETH drips when available)
   - [Google Cloud Sepolia faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
   - Alchemy / Infura community faucets (account required)
5. Target: **≥ 0.2–0.5 Sepolia ETH** on:
   - **Deployer** (one-time contract deploy)
   - **Relayer** (ongoing `mintFromPolymesh` gas) — can be the same wallet for demos

Export the relayer private key only into `.env.testnet` (never commit).

### B. Polymesh testnet POLYX

Polymesh is **permissioned**: you typically need a wallet account and an **on-chain identity (DID)** before transfers work.

1. Install [Polymesh Wallet](https://chromewebstore.google.com/detail/polymesh-wallet/jojhfeoedkpkglbfimdfabpdfjaoolaf) (Chrome).
2. Create an account and select **Testnet**.
3. Open https://portal.polymesh.live/ and complete onboarding / DID registration (v8 testnet supports simplified / self-registered DIDs where enabled).
4. Obtain **test POLYX**:
   - Check the portal for any built-in faucet / request flow
   - Polymesh Discord / community faucet (see [developer links](https://developers.polymesh.network/developer-resources/links/))
   - Internal team faucet if you have one
5. Fund **two** Polymesh accounts if possible:
   - **User** — locks POLYX (Poly → Eth)
   - **Escrow** — holds POLYX and pays Eth → Poly releases (relayer mnemonic)

Target: **≥ 100–1000 test POLYX** on user + escrow (escrow must stay funded).

Useful links:

- Testnet portal: https://portal.polymesh.live/
- Testnet explorer: https://polymesh-testnet.subscan.io/
- RPC list: https://developers.polymesh.network/developer-resources/links/

---

## 2. Prepare env files

```bash
# From repo root
cp bridge/relayer/.env.testnet.example bridge/relayer/.env.testnet
# or
cp bridge/envs/testnet.env bridge/relayer/.env.testnet
```

Edit `bridge/relayer/.env.testnet`:

| Variable | What to put |
|----------|-------------|
| `BRIDGE_ETH_RPC_URL` | Sepolia RPC (prefer Alchemy/Infura; public node is OK for light demos) |
| `BRIDGE_ETH_RELAYER_KEY` | Sepolia private key with ETH |
| `BRIDGE_POLYMESH_ESCROW_MNEMONIC` | Escrow secret phrase (testnet only) |
| `BRIDGE_API_TOKEN` | Long random string |
| `BRIDGE_ADDRESS` / `WPOLYX_ADDRESS` | After deploy (next section) |

Also set matching vars for the web UI (it loads the same `.env.testnet` when `BRIDGE_NETWORK=testnet`).

---

## 3. Deploy contracts to Sepolia

```bash
# Derive relayer address from the key, e.g.:
# cast wallet address --private-key $BRIDGE_ETH_RELAYER_KEY

export BRIDGE_ETH_RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"  # or your RPC
export DEPLOYER_KEY="0x..."           # funded Sepolia key
export RELAYER_ADDRESS="0x..."        # must match BRIDGE_ETH_RELAYER_KEY

./bridge/scripts/deploy-eth.sh --network sepolia \
  --private-key "$DEPLOYER_KEY" \
  --relayer "$RELAYER_ADDRESS"

# Optional verification:
# ETHERSCAN_API_KEY=... ./bridge/scripts/deploy-eth.sh --network sepolia --verify ...
```

The script writes `bridge/deployments/sepolia.json` and prints:

```text
WPOLYX_ADDRESS=0x...
BRIDGE_ADDRESS=0x...
```

Copy those into `.env.testnet`.

In MetaMask: **Import token** → paste `WPOLYX_ADDRESS`.

---

## 4. Fund escrow (Polymesh testnet)

Local `yarn bootstrap` uses `//Alice` and **does not apply** on public testnet.

From portal or your tooling:

1. Send test POLYX **to the escrow SS58 address** (derive from `BRIDGE_POLYMESH_ESCROW_MNEMONIC`).
2. Confirm balance on Subscan / portal.
3. Keep a buffer for many Eth → Poly releases.

---

## 5. Run relayer (testnet)

```bash
cd bridge/relayer
yarn install
yarn start:testnet
```

You should see logs like:

```text
network=testnet
Ethereum RPC=... chain Sepolia
connected to Polymesh; escrow=5F... balance=...
API on :3006 auth=on
```

Health check:

```bash
curl -s http://127.0.0.1:3006/health | jq
```

---

## 6. Run web UI against testnet

```bash
cd bridge/web
BRIDGE_NETWORK=testnet yarn dev
```

1. Open http://localhost:5173  
2. **Connect MetaMask** → should prompt for **Sepolia** (not Anvil)  
3. Polymesh side: for now locks still go through the web API with a mnemonic/dev path — use a **testnet** mnemonic only, or CLI:

```bash
cd bridge/relayer
# export env from .env.testnet first
BRIDGE_NETWORK=testnet yarn lock "<testnet user mnemonic>" 0xYourMetaMask 1.0
```

4. Wait for transfer status → `completed` and wPOLYX balance on Sepolia.  
5. Flip direction: burn wPOLYX via MetaMask → POLYX released from escrow.

---

## 7. First-transfer checklist

- [ ] Sepolia ETH on deployer + relayer  
- [ ] Polymesh DID + test POLYX on user  
- [ ] Escrow funded with test POLYX  
- [ ] `deploy-eth.sh --network sepolia` succeeded  
- [ ] Addresses in `.env.testnet`  
- [ ] `yarn start:testnet` healthy  
- [ ] Lock 0.1–1 POLYX → mint seen on Etherscan  
- [ ] Burn half → POLYX back on Subscan  

---

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| `Missing BRIDGE_ETH_RELAYER_KEY` | Empty key in `.env.testnet` |
| Mint txs fail / OOG | Relayer Sepolia wallet empty |
| Eth→Poly stuck `failed` / no release | Escrow underfunded |
| `401` on lock-intent | Wrong `BRIDGE_API_TOKEN` |
| MetaMask wrong chain | Connect again; UI switches to chain id from status API |
| Polymesh transfer fails | No DID / insufficient POLYX for fees |
| RPC 429 | Switch to Alchemy/Infura Sepolia URL |

---

## Local vs testnet quick ref

| | Local | Testnet |
|--|--------|---------|
| Env | `bridge/envs/local.env` / `.env` | `.env.testnet` |
| Eth | Anvil `:8546` | Sepolia `11155111` |
| Polymesh | compose `ws://127.0.0.1:9944` | `wss://testnet-rpc.polymesh.live/` |
| Deploy | `./bridge/scripts/deploy-eth.sh` | `./bridge/scripts/deploy-eth.sh --network sepolia` |
| Relayer | `yarn start` | `yarn start:testnet` |
| Escrow fund | `yarn bootstrap` | manual transfer of test POLYX |
| Web | `yarn dev` | `BRIDGE_NETWORK=testnet yarn dev` |

---

## Security reminders

- Testnet keys can still be reused by others if leaked — use dedicated throwaways.  
- Do not expose `:3006` without a strong `BRIDGE_API_TOKEN`.  
- Do not point this MVP at mainnet.
