# my-oif-contracts

Foundry contract suite for the OIF (Open Intents Framework), with [CREATE2](https://github.com/Arachnid/deterministic-deployment-proxy) deployment scripts for reproducible cross-chain addresses on Ethereum Sepolia and Base Sepolia.

## Prerequisites

```bash
brew install foundry jq
```

## Setup

```bash
cd packages/my-oif-contracts
cp .env.example .env
# fill in values — see table below
```

## `.env` Variables

| Variable            | Required       | Purpose                                                                                   | Where to get                                                                                    |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `PRIVATE_KEY`       | Yes            | Deployer EOA used by `forge script --broadcast`                                           | Export from a wallet you control                                                                |
| `ALCHEMY_API_KEY`   | Yes            | Resolves chain labels (`eth-sepolia`, `base-sepolia`) to RPC URLs; interpolated in config | [dashboard.alchemy.com](https://dashboard.alchemy.com/)                                         |
| `ETHERSCAN_API_KEY` | For `--verify` | Source-code verification on Etherscan / Basescan (same key works for both)                | [etherscan.io/apis](https://etherscan.io/apis) · [basescan.org/apis](https://basescan.org/apis) |
| `SALT`              | Yes            | Shared `bytes32` CREATE2 salt; keep it fixed across chains for same-address deploys       | Any 32-byte hex constant, e.g. `0x000…0`                                                        |

> Do not commit `.env`.

## Deploy Commands

Scripts live in `script/deploy/universal/`. They accept an Alchemy chain label (`eth-sepolia`, `base-sepolia`) **or** a full RPC URL.

### Hyperliquid (chainId 998/999) Policy

For Hyperliquid testnet/mainnet, deploy wrappers apply chain-specific defaults automatically:

- enforce `profile=size`
- enforce `gas-estimate-multiplier=100`
- enforce legacy tx mode (`--legacy`) to avoid EIP-1559 fee estimation RPC edge cases
- auto-detect and print current `foundry.toml` `profile.size` settings (e.g. `optimizer_runs`, `via_ir`)
- keep this policy isolated to `998/999` only; other chains stay on default profile/settings

This means Hyperliquid deployments intentionally produce different CREATE2 addresses from non-Hyperliquid chains.

---

### `deploy-one-chain.sh` — Deploy contracts on one chain

| Parameter      | Required         | Notes                                                  |
| -------------- | ---------------- | ------------------------------------------------------ |
| `<chain>`      | **Yes**          | Chain label or full RPC URL                            |
| `--verify`     | No · recommended | Verify source on the block explorer right after deploy |
| `--only <key>` | No               | Deploy only the named contract (see valid keys below)  |

```bash
# Deploy all contracts
bash ./script/deploy/universal/deploy-one-chain.sh eth-sepolia
bash ./script/deploy/universal/deploy-one-chain.sh base-sepolia

# Hyperliquid (legacy tx is auto-enabled; explicit --legacy is also accepted)
bash ./script/deploy/universal/deploy-one-chain.sh hyperliquid-testnet
bash ./script/deploy/universal/deploy-one-chain.sh hyperliquid-testnet --legacy

# Deploy and verify in one step
bash ./script/deploy/universal/deploy-one-chain.sh eth-sepolia --verify
bash ./script/deploy/universal/deploy-one-chain.sh base-sepolia --verify
bash ./script/deploy/universal/deploy-one-chain.sh hyperliquid-testnet --verify --legacy

# Deploy a single contract only
bash ./script/deploy/universal/deploy-one-chain.sh eth-sepolia --only hyperlaneOracle --verify

# Use a public RPC instead of an Alchemy label
bash ./script/deploy/universal/deploy-one-chain.sh https://ethereum-sepolia-rpc.publicnode.com
```

**Sample output**

```
[deploy] eth-sepolia
  inputSettlerEscrow   → 0x8429Ba43...030c12c1  (new)
  outputSettlerSimple  → 0x07C26291...Cfb90Eb  (new)
  hyperlaneOracle      → 0x0BeC1724...feD2574  (new)
addresses.json updated.
```

---

### `dry-run.sh` — Simulate on a local Anvil fork (no broadcast)

Writes `addresses.dry-run.json`. Picks a free local port automatically.

| Parameter      | Required | Notes                            |
| -------------- | -------- | -------------------------------- |
| `<chain>`      | **Yes**  | Chain label or full RPC URL      |
| `--only <key>` | No       | Simulate only the named contract |

```bash
bash ./script/deploy/universal/dry-run.sh eth-sepolia
bash ./script/deploy/universal/dry-run.sh base-sepolia --only outputSettlerSimple
```

---

### `verify-one-chain.sh` — Re-verify already-deployed contracts

| Parameter                 | Required | Notes                                                      |
| ------------------------- | -------- | ---------------------------------------------------------- |
| `<chain>`                 | **Yes**  | Chain label or full RPC URL                                |
| `--only <key>`            | No       | Verify only the named contract                             |
| `--soft-fail`             | No       | Exit 0 on verification failure (useful in CI chains)       |
| `--addresses-path <path>` | No       | Use a different addresses file instead of `addresses.json` |

```bash
bash ./script/deploy/universal/verify-one-chain.sh eth-sepolia
bash ./script/deploy/universal/verify-one-chain.sh eth-sepolia --only inputSettlerCompact
bash ./script/deploy/universal/verify-one-chain.sh base-sepolia --soft-fail
```

---

### Valid `--only` keys

| Key                    | Contract                                                 |
| ---------------------- | -------------------------------------------------------- |
| `inputSettlerEscrow`   | `src/input/escrow/InputSettlerEscrow.sol`                |
| `inputSettlerCompact`  | `src/input/compact/InputSettlerCompact.sol`              |
| `outputSettlerSimple`  | `src/output/simple/OutputSettlerSimple.sol`              |
| `hyperlaneOracle`      | `src/integrations/oracles/hyperlane/HyperlaneOracle.sol` |
| `catsMulticallHandler` | `lib/cats-contracts/…`                                   |

## Cross-Chain Address Parity

Contracts with no constructor args land on the **same address on every chain** as long as `SALT` stays fixed. Exceptions (args differ per chain):

- `inputSettlerCompact` — takes a per-chain `compact` address
- `hyperlaneOracle` — takes per-chain `mailbox`, `customHook`, and `ism`

## References

- Foundry Book: [book.getfoundry.sh](https://book.getfoundry.sh/)
- Hyperlane Mailbox deployments: [docs.hyperlane.xyz/docs/reference/addresses/deployments/mailbox](https://docs.hyperlane.xyz/docs/reference/addresses/deployments/mailbox)
- OIF contracts: [openintentsframework/oif-contracts](https://github.com/openintentsframework/oif-contracts)
- Circle EURC/USDC testnet faucet: [faucet.circle.com](https://faucet.circle.com/)
