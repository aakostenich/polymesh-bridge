# MetaMask: get test wPOLYX and bridge to Polymesh

Goal: **wPOLYX in MetaMask** → burn → **native POLYX** on Polymesh.

```
Polymesh POLYX  ──lock──▶  relayer mints wPOLYX  ──in MetaMask──▶  burn  ──▶  POLYX released
```

You cannot get native POLYX *inside* MetaMask (it is not an EVM chain). MetaMask holds **wPOLYX**; Polymesh holds **POLYX** (Wallet / Portal / our UI balances).

---

## Path A — Local (works today, no public faucet)

### 0. Stack up

```bash
# Polymesh compose + Anvil
./scripts/start-env.sh --env-file envs/8.0 --profile eth

# Relayer
cd bridge/relayer && yarn start

# Web UI
cd bridge/web && yarn dev
```

### 1. Add Anvil to MetaMask

| Field | Value |
|-------|--------|
| Network name | Anvil Local (POLYX Bridge) |
| RPC URL | `http://127.0.0.1:8546` |
| Chain ID | `1337` |
| Currency | ETH |

Or click **Connect MetaMask** in the UI — it adds the network for you.

### 2. Get wPOLYX into MetaMask

**UI (easiest):**

1. Open http://localhost:5173 → **Bridge**
2. **1. Connect MetaMask**
3. **2. Get test wPOLYX** (locks 10 POLYX from //Bob → mints to you)
4. Approve **Add wPOLYX token** if prompted (6 decimals)

**CLI:**

```bash
cd bridge/relayer
yarn faucet:wpolyx 0xYOUR_METAMASK_ADDRESS 10
```

Wait until status is `completed` (~30–60s for finality).

### 3. Bridge to Polymesh (Eth → Poly)

1. UI: **3. Switch to To Polymesh** (or set direction manually)
2. **From:** your MetaMask  
3. **To:** Bob / Alice / Dave (Polymesh SS58)  
4. Amount e.g. `1`  
5. **Bridge to Polymesh** → approve + burn in MetaMask  
6. Wait for transfer status `completed`  
7. Check recipient POLYX balance on **Portfolio** tab  

---

## Path B — Public testnet (Sepolia × Polymesh testnet)

1. Follow **[TESTNET.md](./TESTNET.md)** first (deploy, fund escrow, `.env.testnet`).
2. MetaMask → **Sepolia** (not Anvil).
3. Get **Sepolia ETH** (gas): https://faucets.chain.link/sepolia  
4. Get **test POLYX** + DID on Polymesh testnet (Portal).
5. Mint wPOLYX to MetaMask:

```bash
cd bridge/relayer
yarn start:testnet   # other terminal
yarn faucet:wpolyx 0xYourMetaMask 5 "your funded testnet mnemonic words…"
```

6. Import token `WPOLYX_ADDRESS` from `.env.testnet` (6 decimals).  
7. UI `yarn dev:testnet` → MetaMask → **To Polymesh** → burn to your Polymesh SS58.

HTTP faucet button is **disabled** on testnet (needs real POLYX).

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Get test wPOLYX hangs | Relayer offline → `yarn start` |
| 0 wPOLYX after faucet | Wait finality; refresh; re-add token |
| MetaMask wrong network | Connect again; chain id must match UI status |
| Burn fails | Need wPOLYX + ETH for gas; bridge not paused |
| No POLYX on Polymesh | Escrow empty; relayer offline; wrong SS58 |

---

## What you should see

1. MetaMask: **wPOLYX** balance increases after faucet.  
2. After burn: wPOLYX down; activity shows burn + later release.  
3. Portfolio: Polymesh recipient **POLYX** up.
