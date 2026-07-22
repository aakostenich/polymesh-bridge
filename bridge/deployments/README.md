# Deployments

JSON files written by `bridge/scripts/deploy-eth.sh`:

| File | Network |
|------|---------|
| `local.json` | Anvil (chain id 1337) |
| `sepolia.json` | Ethereum Sepolia (11155111) |

Example:

```json
{
  "network": "sepolia",
  "chainId": 11155111,
  "wPolyx": "0x…",
  "bridge": "0x…",
  "relayer": "0x…",
  "deployedAt": "2026-07-22T00:00:00Z"
}
```

Copy `wPolyx` / `bridge` into `bridge/relayer/.env.testnet` after deploy.
Do not store private keys here.
