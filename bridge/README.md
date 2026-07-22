# POLYX ↔ wPOLYX Bridge (Polymesh × Ethereum)

A two-way bridge between **native POLYX** on Polymesh and **wrapped wPOLYX (ERC-20)**
on Ethereum (local Anvil or **Sepolia testnet**).

> ⚠️ **MVP / research prototype.** Single trusted relayer. Not audited. Do not
> use for real assets. See [Trust model & limitations](#trust-model--limitations).
>
> **Public testnet:** see **[TESTNET.md](./TESTNET.md)** — faucets, Sepolia deploy, relayer env.

---

## How it works

Escrow / lock-mint model — self-balancing, **no POLYX minting** required:

```
Polymesh → Ethereum     user locks POLYX in escrow  ──▶  relayer mints wPOLYX
Ethereum → Polymesh     user burns wPOLYX           ──▶  relayer releases POLYX from escrow
```

Both **6 decimals** (matching POLYX), so amounts map 1:1 with no conversion.

```
┌─────────────────────────────┐        ┌──────────────────────────┐        ┌─────────────────────────┐
│  Polymesh (dev env)         │        │  Relayer (TypeScript)    │        │  Ethereum (Anvil :8546) │
│                             │        │                          │        │                         │
│  escrow account (POLYX)     │◀───────│  watches both chains     │────────│  PolyxBridge.sol        │
│  sdk._polkadotApi events    │        │  SQLite replay store     │        │  WrappedPolyx.sol       │
└─────────────────────────────┘        └──────────────────────────┘        └─────────────────────────┘
```

### Components

| Part | Location | Role |
|---|---|---|
| `WrappedPolyx.sol` | `contracts/src/` | ERC-20 wPOLYX, 6 decimals, mintable (by bridge) + burnable |
| `PolyxBridge.sol` | `contracts/src/` | Router: `bridgeToPolymesh` (burn) + `mintFromPolymesh` (mint). Pause, replay guard |
| `relayer/src/polymesh.ts` | `relayer/` | Polymesh SDK: escrow signer, `transferPolyx`, balance, finalized-block + transfer events |
| `relayer/src/eth.ts` | `relayer/` | ethers v6: bridge contract reader + relayer wallet for mints |
| `relayer/src/db.ts` | `relayer/` | SQLite replay store + scan cursors |
| `relayer/src/relayer.ts` | `relayer/` | Main loop: both watchers |

---

## Quick start

### 1. Start the dev environment (with the bridge's Ethereum node)

```bash
./scripts/start-env.sh --env-file envs/8.0 --profile eth
```

This starts the usual Polymesh stack **plus** a standalone Anvil node on host
port **8546** (`compose.yaml` service `eth-anvil`, profile `eth`). The profile
is distinct from the repo's `evm` profile (Polymesh's own EVM layer on 8545).

### 2. Deploy the bridge contracts

```bash
# Local Anvil
./bridge/scripts/deploy-eth.sh
# → bridge/deployments/local.json

# Sepolia testnet (needs funded DEPLOYER_KEY + RELAYER_ADDRESS)
./bridge/scripts/deploy-eth.sh --network sepolia \
  --private-key "$DEPLOYER_KEY" --relayer "$RELAYER_ADDRESS"
# → bridge/deployments/sepolia.json
```

Copy addresses into the matching env file:

```bash
# Local
cp bridge/relayer/.env.example bridge/relayer/.env
# or: cp bridge/envs/local.env bridge/relayer/.env

# Testnet
cp bridge/relayer/.env.testnet.example bridge/relayer/.env.testnet
# fill secrets + BRIDGE_ADDRESS / WPOLYX_ADDRESS — see TESTNET.md
```

### 3. Install relayer deps & bootstrap the escrow

```bash
cd bridge/relayer
yarn install
yarn bootstrap        # funds escrow from dev //Alice (one-time, fresh chain)
```

### 4. Run the relayer

```bash
yarn start              # local (.env)
yarn start:testnet      # loads .env.testnet (BRIDGE_NETWORK=testnet)
```

### 5. Open the web UI (easiest way to click around)

```bash
cd bridge/web
yarn install
yarn dev                          # local
BRIDGE_NETWORK=testnet yarn dev   # Sepolia + Polymesh testnet config
```

Open **http://localhost:5173** — pick accounts, amounts, flip direction, bridge both ways.
MetaMask switches to Anvil (local) or Sepolia (testnet). See `bridge/web/README.md` and **[TESTNET.md](./TESTNET.md)**.

### 6. Or exercise both directions via CLI / E2E

```bash
# Polymesh -> Ethereum: lock POLYX (registers intentId, memo = b:<id>)
yarn lock //Bob 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 12.5

# Full E2E (both directions + optional relayer restart)
./bridge/scripts/e2e-bridge.sh
./bridge/scripts/e2e-bridge.sh --restart

# Lighter smoke (cast-driven mint/burn without full status wait)
./bridge/scripts/bridge-smoke-test.sh
```

Run the contract unit tests anytime with Foundry:

```bash
cd bridge/contracts
forge test
```

---

## Data flow detail

### Ethereum → Polymesh (burn wPOLYX → release POLYX)

1. User calls `PolyxBridge.bridgeToPolymesh(polymeshRecipient, amount)` after
   approving the bridge to burn their wPOLYX.
2. Contract burns wPOLYX (`WrappedPolyx.burnFrom`) and emits `BridgedToPolymesh(id, sender, polymeshRecipient, amount)`.
3. Relayer records transfer status `awaiting_finality` → `relaying`.
4. After `N` confirmations (`BRIDGE_ETH_CONFIRMATIONS`), relayer releases POLYX
   from escrow and marks status `completed` (or `failed` on error / retry).

**Binding is clean:** the Polymesh recipient comes straight from the event.

### Polymesh → Ethereum (lock POLYX → mint wPOLYX)

1. Client (CLI / web) `POST /lock-intent` → relayer stores a SQLite intent and
   returns `intentId` + memo `b:<intentId>` (fits Polymesh 32-byte memo).
2. Client `transferPolyx` to escrow **with that memo**.
3. Relayer scans finalized blocks for `Balances.Transfer` into escrow, parses
   the extrinsic memo for `intentId`, validates amount/sender, sets status
   `locked` then `relaying`.
4. Relayer calls `mintFromPolymesh(ethRecipient, amount, polyEventId)` where
   `polyEventId` is derived from `intentId` (stable, no block collisions).
5. Status → `completed`. Incomplete mints are retried from SQLite after restarts.

### Transfer status state machine

| Status | Meaning |
|---|---|
| `intent_registered` | Poly→Eth intent created; lock not observed yet |
| `locked` | Escrow transfer observed (memo matched) |
| `awaiting_finality` | Eth→Poly burn seen; waiting confirmations |
| `relaying` | Mint or release in flight |
| `completed` | Destination leg finished |
| `failed` | Terminal validation error or last relay attempt failed (retriable if not mismatch) |

Query API (relayer `:3006`, also proxied at web `/api/transfers`):

- `GET /health`
- `POST /lock-intent` `{ polySender, ethRecipient, amount }`
- `GET /transfers`
- `GET /transfers/:intentId`

---

## Configuration

All knobs are env vars (see `bridge/relayer/.env.example`):

| Var | Default | Meaning |
|---|---|---|
| `BRIDGE_ETH_RPC_URL` | `http://127.0.0.1:8546` | Anvil RPC |
| `BRIDGE_ETH_CHAIN_ID` | `1337` | Anvil chain id |
| `BRIDGE_ETH_RELAYER_KEY` | Anvil account[1] | Relayer's Eth key (must match on-chain `relayer()`) |
| `BRIDGE_ADDRESS` / `WPOLYX_ADDRESS` | — | Deployed contract addresses |
| `BRIDGE_ETH_CONFIRMATIONS` | `2` | Eth confirmations before release |
| `POLYMESH_NODE_URL` | `ws://127.0.0.1:9944` | Polymesh node |
| `POLYMESH_GRAPHQL_URL` | `http://127.0.0.1:3000` | Subquery middleware |
| `BRIDGE_POLYMESH_ESCROW_MNEMONIC` | `//Charlie` | Escrow Polymesh key |
| `BRIDGE_POLYMESH_FINALITY_BLOCKS` | `5` | Polymesh blocks before mint |
| `BRIDGE_POLL_INTERVAL_MS` | `4000` | Main poll cadence |
| `BRIDGE_INTENT_API_PORT` | `3006` | Relayer HTTP API |
| `BRIDGE_API_TOKEN` | `dev-bridge-token` | Bearer token (`off` disables auth) |
| `BRIDGE_API_RATE_MAX` | `30` | Max `POST /lock-intent` per IP per window |
| `BRIDGE_MIN_AMOUNT_POLYX` | `0.01` | Min transfer size |
| `BRIDGE_MAX_AMOUNT_POLYX` | `10000` | Max per-tx size |
| `BRIDGE_DAILY_VOLUME_POLYX` | `100000` | UTC-day volume cap |

---

## Threat model

### Assets & actors

| Asset | Who controls it |
|---|---|
| Escrow POLYX (Polymesh) | Relayer hot key (`BRIDGE_POLYMESH_ESCROW_MNEMONIC`) |
| wPOLYX mint authority | Bridge contract `relayer` role (Eth key) |
| Bridge admin (`owner`) | Deployer — can pause / set relayer |
| User POLYX / wPOLYX | User wallets |

### Trust assumptions (current MVP)

1. **Single honest relayer.** Users trust the operator not to mint unbacked
   wPOLYX, censor withdrawals, or drain escrow.
2. **Correct local chain config.** RPC endpoints and contract addresses are
   not MITM'd (local demo; production needs authenticated endpoints + pin).
3. **Intent API authenticity.** `POST /lock-intent` and `GET /transfers` require
   `Authorization: Bearer <BRIDGE_API_TOKEN>` (default `dev-bridge-token`). Rate
   limited per IP. Set token to a strong secret outside local demo; use `off`
   only on loopback.
4. **Finality heuristics.** Polymesh uses `latest - N` blocks; Ethereum uses
   `latest - confirmations`. Not full GRANDPA/PoS finality proofs.
5. **Dev keys.** Anvil / `//Alice` style keys are public. Never use with value.

### What is protected

| Risk | Mitigation |
|---|---|
| Double mint for same lock | On-chain `processedNonces[polyEventId]` + SQLite `processed_events` |
| Double release for same burn | SQLite by Eth event id; burn nonce monotonic on contract |
| Wrong Eth recipient (Poly→Eth) | Memo `b:<intentId>` → SQLite lookup (not amount matching) |
| Amount / sender tamper vs intent | Relayer rejects mismatch → `failed` |
| Relayer crash mid-flight | Intent + lock observation persisted; incomplete mints retried |

### What is *not* protected (known residual risk)

| Risk | Notes |
|---|---|
| Malicious / compromised relayer | Can mint freely to any address; can steal escrow POLYX |
| Censorship | Relayer can ignore burns/locks |
| Intent DoS | Mitigated by Bearer auth + rate limit; still keep port private |
| Chain reorg beyond heuristic | Possible incorrect skip/retry on shallow finality |
| Smart-contract bugs | Contracts are unaudited research code |

### Hardening roadmap

- M-of-N relayer / threshold mint
- Strong production secrets (rotate default `dev-bridge-token`)
- On-chain caps / multi-relayer (off-chain min/max/daily already wired)
- Real GRANDPA / beacon finality checks
- External audit before any real-asset use

---

## File map

```
bridge/
├── README.md                       this file
├── TESTNET.md                      Sepolia + Polymesh testnet guide
├── envs/                           local.env + testnet.env templates
├── deployments/                    deploy-eth.sh output (local.json / sepolia.json)
├── .gitignore
├── contracts/                      Solidity (Foundry)
│   ├── foundry.toml
│   ├── src/
│   │   ├── WrappedPolyx.sol
│   │   └── PolyxBridge.sol
│   ├── script/
│   │   └── Deploy.s.sol
│   └── test/
│       └── PolyxBridge.t.sol
├── relayer/                        TypeScript
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   └── src/
│       ├── config.ts
│       ├── abi.ts
│       ├── eth.ts
│       ├── polymesh.ts
│       ├── db.ts
│       ├── relayer.ts
│       └── ops/
│           ├── bootstrap-escrow.ts
│           └── lock-polyx.ts
├── web/                            Local demo UI (Vite + Express)
│   ├── README.md
│   ├── server/                     Polymesh lock / balances API
│   └── src/                        React frontend
└── scripts/
    ├── deploy-eth.sh
    ├── bridge-smoke-test.sh
    └── e2e-bridge.sh              full E2E (+ optional --restart)
```
