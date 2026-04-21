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
```

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
