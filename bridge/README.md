# POLYX ↔ wPOLYX Bridge (Polymesh × Ethereum)

A two-way bridge between **native POLYX** on Polymesh and **wrapped wPOLYX (ERC-20)**
on a local Ethereum chain (Anvil), running alongside this repo's Polymesh dev
environment.

> ⚠️ **MVP / research prototype.** Single trusted relayer. Not audited. Do not
> use for real assets. See [Trust model & limitations](#trust-model--limitations).

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
./bridge/scripts/deploy-eth.sh
```

Outputs `WPOLYX_ADDRESS` and `BRIDGE_ADDRESS`. Copy them into
`bridge/relayer/.env`:

```bash
cp bridge/relayer/.env.example bridge/relayer/.env
# edit BRIDGE_ADDRESS and WPOLYX_ADDRESS
```

### 3. Install relayer deps & bootstrap the escrow

```bash
cd bridge/relayer
yarn install
yarn bootstrap        # funds escrow from dev //Alice (one-time, fresh chain)
```

### 4. Run the relayer

```bash
yarn start
```

### 5. Exercise both directions

```bash
# Polymesh -> Ethereum: lock POLYX (sender //Bob) to receive wPOLYX at an Eth address
yarn lock //Bob 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 12.5

# Ethereum -> Polymesh + verify balances
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
3. Relayer scans events past `N` confirmations (`BRIDGE_ETH_CONFIRMATIONS`).
4. Relayer calls `sdk.network.transferPolyx({ to: polymeshRecipient, amount })`
   from the escrow account and marks the event id processed.

**Binding is clean:** the Polymesh recipient comes straight from the event.

### Polymesh → Ethereum (lock POLYX → mint wPOLYX)

1. User transfers POLYX to the escrow (`relayer/src/ops/lock-polyx.ts`), with
   `memo = bridge:<ethRecipient>`.
2. Relayer scans finalized blocks for `Balances.Transfer` events into the
   escrow via `sdk._polkadotApi`.
3. Relayer matches the transfer to a **pending intent** (see limitation below)
   to learn the Ethereum recipient, waits for finality
   (`BRIDGE_POLYMESH_FINALITY_BLOCKS`).
4. Relayer calls `PolyxBridge.mintFromPolymesh(ethRecipient, amount, polyEventId)`.
   The contract's `processedNonces[polyEventId]` guard prevents double-mints.

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

---

## Trust model & limitations

This is a **single-trusted-relayer MVP**. Be aware of:

- **Relayer authority.** The relayer address is the sole authorized minter
  (`onlyRelayer`) and holds the escrow POLYX key. A compromised relayer could
  mint unbacked wPOLYX or misappropriate escrow funds.
- **Poly→Eth recipient binding (MVP).** The relayer learns the Ethereum
  recipient from an out-of-band *pending intent*, matched by `(sender, amount)`.
  This is fragile (same sender + same amount collides) and is intended only for
  local demos. The production-grade path — carrying the eth recipient in a
  settlement instruction `memo` — is stubbed: `lock-polyx.ts` already emits
  `memo = bridge:<ethRecipient>`, and the relayer can be upgraded to parse it
  from the extrinsic instead of relying on intents.
- **No validator set.** No M-of-N, no light-client verification. Replay safety
  is off-chain (SQLite) plus the on-chain `processedNonces` for mints.
- **Dev-only escrow funding.** `bootstrap-escrow.ts` funds the escrow from
  `//Alice`, which only exists on the `--dev` chain.

### Hardening roadmap (out of scope here)

- M-of-N relayer / validator set with on-chain threshold signatures.
- Parse eth recipient from settlement `memo` (remove the intent-matching hack).
- Daily transfer caps + per-transaction limits + circuit breaker (pause is wired).
- Finality: real GRANDPA finality checks (currently a block-count heuristic).
- External security audit before any real-asset use.

---

## File map

```
bridge/
├── README.md                       this file
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
└── scripts/
    ├── deploy-eth.sh
    └── bridge-smoke-test.sh
```
