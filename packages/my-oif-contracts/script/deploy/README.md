# OIF Deploy Scripts

Foundry-based deployment framework for the OIF contracts in `my-oif-contracts`. Targets are deployed via [Nick's CREATE2 factory](https://github.com/Arachnid/deterministic-deployment-proxy) so that addresses with identical constructor args are reproducible across chains.

## Supported Contracts

| Key                    | Source                                                   | Constructor args                           |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------ |
| `inputSettlerEscrow`   | `src/input/escrow/InputSettlerEscrow.sol`                | none                                       |
| `inputSettlerCompact`  | `src/input/compact/InputSettlerCompact.sol`              | `compact` (per-chain)                      |
| `outputSettlerSimple`  | `src/output/simple/OutputSettlerSimple.sol`              | none                                       |
| `hyperlaneOracle`      | `src/integrations/oracles/hyperlane/HyperlaneOracle.sol` | `mailbox`, `customHook`, `ism` (per-chain) |
| `catsMulticallHandler` | `lib/cats-contracts/...`                                 | none                                       |

Each key has a one-to-one mapping to `script/deploy/entry/Deploy<Name>.s.sol`.

## Layout

```
script/deploy/
├── entry/                 # one Foundry script per contract
├── lib/                   # CREATE2 helper, addresses.json writer, JSON readers
├── config/                # per-chain JSON inputs (mailbox, compact, chainLabel, ...)
├── universal/             # wrapper shell scripts
├── addresses.json         # deployed addresses (checked into git)
└── addresses.dry-run.json # fork dry-run output (gitignored, auto-created)
```

## Prerequisites

Make sure `lib/oif-contracts` submodules are initialised (`openzeppelin-contracts`, `permit2`, `the-compact`).

Copy the root-level env template:

```sh
cp .env.example .env
```

Required variables:

| Variable            | Purpose                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRIVATE_KEY`       | Deployer EOA used by `forge script --broadcast`                                                                                              |
| `ALCHEMY_API_KEY`   | Resolves network labels like `eth-sepolia`, `base-sepolia` into RPC URLs. Get one at [dashboard.alchemy.com](https://dashboard.alchemy.com/) |
| `ETHERSCAN_API_KEY` | Used by `--verify`. Get one at [etherscan.io/apis](https://etherscan.io/apis)                                                                |
| `SALT`              | Shared `bytes32` CREATE2 salt across all entry scripts                                                                                       |

## CREATE2 and Cross-Chain Address Parity

- Contracts with no constructor args (or identical args across chains) will land on the **same address on every chain** as long as `SALT` stays fixed.
- Contracts whose constructor args differ per chain still use CREATE2 but the resulting address is chain-specific because `init_code` changes. Currently this applies to:
  - `inputSettlerCompact` — takes `compact` as constructor arg
  - `hyperlaneOracle` — takes `mailbox`, `customHook`, `ism`

## Per-Chain Config

All `config/*.json` are keyed by `chainId`. Each entry also carries a `chainLabel` field for human readability.

### `config/chainLabels.json`

Maps `chainId` → chain label. Used both when writing `addresses.json` and when resolving network labels in shell scripts.

```json
{
  "11155111": { "chainLabel": "eth-sepolia" }
}
```

### `config/inputSettlerCompact.json`

```json
{
  "11155111": {
    "compact": "0x00000000000000171ede64904551eeDF3C6C9788",
    "chainLabel": "eth-sepolia"
  }
}
```

Sources: [The Compact overview](https://developers.uniswap.org/docs/protocols/the-compact/overview#deployments), [uniswap/the-compact](https://github.com/Uniswap/the-compact), [Introducing The Compact](https://blog.uniswap.org/the-compact-v1).

### `config/hyperlaneOracle.json`

```json
{
  "11155111": {
    "mailbox": "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766",
    "customHook": "0x0000000000000000000000000000000000000000",
    "ism": "0x0000000000000000000000000000000000000000",
    "chainLabel": "eth-sepolia"
  }
}
```

Field meaning:

- `mailbox` — Hyperlane Mailbox on that chain.
- `customHook` — **Recommended default: `0x0`**. Passing a non-zero hook tells the Mailbox to replace its `defaultHook` during dispatch, which usually removes the message from `MerkleTreeHook`. In that case the default Multisig-Merkle ISM can never build metadata and the official relayer will silently drop the message. Set this to a specific hook address only if you intentionally run your own verifier stack.
- `ism` — **Recommended default: `0x0`**. Zero falls back to `Mailbox.defaultIsm()`. Override only when the application runs its own ISM.

Sources: [Hyperlane Mailbox deployments](https://docs.hyperlane.xyz/docs/reference/addresses/deployments/mailbox), [Mailbox protocol](https://docs.hyperlane.xyz/docs/protocol/core/mailbox), [ISM overview](https://docs.hyperlane.xyz/docs/protocol/ISM/modular-security).

## Usage

All scripts accept either an Alchemy network label (e.g. `eth-sepolia`) or a full RPC URL.

### Deploy one chain

```sh
bash ./script/deploy/universal/deploy-one-chain.sh eth-sepolia
bash ./script/deploy/universal/deploy-one-chain.sh eth-sepolia --verify
bash ./script/deploy/universal/deploy-one-chain.sh https://ethereum-sepolia-rpc.publicnode.com --only hyperlaneOracle
```

Flags:

- `--verify` — verify on the explorer right after deploy
- `--only <contractKey>` — deploy only the specified contract
- `--profile <foundry_profile>` — override the Foundry compilation profile (see `foundry.toml`)
- `--gas-estimate-multiplier <int>` — override Forge's gas estimate multiplier (default `130`)
- `--legacy` — use legacy tx mode (auto-enabled on Hyperliquid 998/999)

#### Chains with low block gas limit (e.g. Hyperliquid)

Hyperliquid testnet (`chainId=998`) and mainnet (`chainId=999`) enforce a **3 M gas block limit**. The deploy wrappers now apply a conservative policy automatically:

- `--profile size` is enforced on chain `998/999`
- `--gas-estimate-multiplier 100` is enforced on chain `998/999`
- `--legacy` is enforced on chain `998/999` (avoids EIP-1559 fee estimation issues on some RPCs)
- wrappers print detected `foundry.toml` `profile.size` values (`optimizer_runs`, `via_ir`) for audit visibility

These defaults are chain-scoped. Other chains keep default profile + default multiplier unless you override them manually.

Background:

| Issue                     | Cause                                                                           | Fix                      |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------ |
| Bytecode too large        | Unoptimised deployed bytecode ≥ 15 KB → code deposit > 3 M gas                  | Enforce `--profile size` |
| Forge estimate multiplier | Forge multiplies `eth_estimateGas` by 1.3× → `tx.gas_limit` exceeds block limit | Enforce multiplier `100` |

With `--profile size`, `eth_estimateGas` for the largest contract (`inputSettlerEscrow`) is around ~2.49 M gas. Forge's default 1.3× multiplier pushes the submitted `tx.gas_limit` above 3 M, which the RPC rejects before execution. Setting `--gas-estimate-multiplier 100` keeps the submitted gas under block limit while preserving dynamic estimation.

```sh
# Hyperliquid testnet — dry-run (auto-applies profile=size + multiplier=100)
bash ./script/deploy/universal/dry-run.sh https://rpc.hyperliquid-testnet.xyz/evm

# Hyperliquid testnet — broadcast (same auto policy)
bash ./script/deploy/universal/deploy-one-chain.sh https://rpc.hyperliquid-testnet.xyz/evm

# Hyperliquid mainnet — broadcast (same auto policy)
bash ./script/deploy/universal/deploy-one-chain.sh https://rpc.hyperliquid.xyz/evm

# Optional explicit form (equivalent on Hyperliquid)
bash ./script/deploy/universal/deploy-one-chain.sh \
  https://rpc.hyperliquid.xyz/evm --profile size --gas-estimate-multiplier 100 --legacy
```

Bytecode sizes with the `size` profile:

| Contract               | Default | `size` profile | `eth_estimateGas` | Forge 1.3× | Deployable with recommendation        |
| ---------------------- | ------- | -------------- | ----------------- | ---------- | ------------------------------------- |
| `inputSettlerEscrow`   | 19.6 KB | **10.2 KB**    | ~2.49 M           | ~3.23 M ❌ | ✅ w/ `--gas-estimate-multiplier 100` |
| `inputSettlerCompact`  | 15.9 KB | **8.2 KB**     | < 2.49 M          | < 3 M ✅   | ✅                                    |
| `outputSettlerSimple`  | 9.0 KB  | 3.6 KB         | < 2 M             | < 3 M ✅   | ✅                                    |
| `hyperlaneOracle`      | 6.8 KB  | —              | < 2 M             | < 3 M ✅   | ✅                                    |
| `catsMulticallHandler` | 6.4 KB  | —              | < 2 M             | < 3 M ✅   | ✅                                    |

> ⚠️ **Address parity warning** — CREATE2 addresses are derived from `keccak256(init_code)`. The `size` profile produces different bytecode, so **all contract addresses on Hyperliquid will differ from those on other chains** (eth-sepolia, base-sepolia, …). This is an intentional trade-off: cross-chain address parity is sacrificed to work within Hyperliquid's gas limit. Never use `--profile size` on a chain that should share addresses with other deployments.

### Dry-run on a local Anvil fork

Writes to `addresses.dry-run.json`. Picks a free local port automatically.

```sh
bash ./script/deploy/universal/dry-run.sh eth-sepolia
bash ./script/deploy/universal/dry-run.sh eth-sepolia --only outputSettlerSimple
```

### Re-verify a previously deployed chain

```sh
bash ./script/deploy/universal/verify-one-chain.sh eth-sepolia
bash ./script/deploy/universal/verify-one-chain.sh eth-sepolia --only inputSettlerCompact
bash ./script/deploy/universal/verify-one-chain.sh hyperliquid-testnet  # auto-uses FOUNDRY_PROFILE=size
```

> Hyperliquid verify will also print a warning that CREATE2 addresses can differ from non-Hyperliquid chains.

Flags:

- `--only <contractKey>` — verify only the specified contract
- `--addresses-path <path>` — point at a different addresses file
- `--soft-fail` — exit 0 on verification failure, useful when chaining scripts

## Valid `--only` values

`inputSettlerEscrow` · `inputSettlerCompact` · `outputSettlerSimple` · `hyperlaneOracle` · `catsMulticallHandler`

## `addresses.json` shape

```json
{
  "11155111": {
    "chainLabel": "eth-sepolia",
    "inputSettlerEscrow": "0x...",
    "inputSettlerCompact": "0x...",
    "outputSettlerSimple": "0x...",
    "hyperlaneOracle": "0x...",
    "catsMulticallHandler": "0x..."
  }
}
```

## Notes

- `deploy-one-chain.sh` checks for the CREATE2 factory on the target chain and bootstraps it if missing.
- `verify-one-chain.sh` only touches entries that exist in `addresses.json` and are non-zero.
- Entry scripts revert immediately if the target chain is missing any required config entry.
