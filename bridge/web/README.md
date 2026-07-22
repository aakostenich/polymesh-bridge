# POLYX Bridge — Local Web UI

Clickable demo UI for the POLYX ↔ wPOLYX bridge. Uses:

- **Polymesh** via a small Express API (dev keys `//Alice` / `//Bob` / …)
- **Ethereum (Anvil)** via public Foundry demo keys (no MetaMask required)
- **Relayer** intent API on `:3006` for Poly→Eth mint binding

> Local demo only. Dev keys are public. Do not use with real funds.

## Prerequisites

1. Dev env up with Anvil: `./scripts/start-env.sh --env-file envs/8.0 --profile eth`
2. Contracts deployed + `bridge/relayer/.env` filled (`BRIDGE_ADDRESS`, `WPOLYX_ADDRESS`)
3. Escrow bootstrapped: `cd bridge/relayer && yarn bootstrap`
4. Relayer running: `cd bridge/relayer && yarn start`

## Run

```bash
cd bridge/web
yarn install
yarn dev
```

Open **http://localhost:5173**

| Process | Port |
|---|---|
| Vite UI | `5173` |
| Web API | `5174` (proxied as `/api`) |
| Relayer intent API | `3006` |
| Anvil | `8546` |

## What you can click

1. **Polymesh → Ethereum** — pick Bob/Alice/Dave, amount, Anvil recipient → locks POLYX and waits for the relayer to mint wPOLYX.
2. **Ethereum → Polymesh** — flip direction, burn wPOLYX from an Anvil account → relayer releases POLYX from escrow.
3. Live **status pills**, balances, activity log, and recent on-chain bridge events.

Config is read from `bridge/relayer/.env` (override with `bridge/web/.env` if needed).
