# my-oif-solver

Project wrapper around the Rust [`openintentsframework/oif-solver`](https://github.com/openintentsframework/oif-solver) in `lib/oif-solver/`, plus TypeScript utilities in `scripts/` (entry `scripts/index.ts`) for quotes, approvals, `open`, `openFor`, refunds, and order status checks.

## Prerequisites

Required tools:

- Rust and Cargo
- Node.js and npm
- Redis
- `jq`

Initial setup:

```bash
cp .env.example .env
npm install
```

## `.env` Setup

Keep secrets in `.env`. Do not commit this file.

| Variable                       | Required                        | Purpose                                                                                              | Where to get it                                       |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `DEPLOYMENT_PRIVATE_KEY`       | Optional for this package       | Used during contract deployment and setup flows.                                                     | Export from a wallet you control.                     |
| `SOLVER_PRIVATE_KEY`           | Yes                             | The solver wallet. It signs the solver-managed on-chain transactions after an order is accepted.     | Export from a wallet you control.                     |
| `USER_PRIVATE_KEY`             | Required for CLI user flows     | The user wallet used by `quotes`, `open`, `openFor`, `refund`, and related commands in this package. | Export from a wallet you control.                     |
| `SOLVER_BASE_URL`              | Usually yes for TS commands     | Base URL for the solver HTTP API. The default is `http://127.0.0.1:3000/api/v1`.                     | Local solver endpoint.                                |
| `REDIS_URL`                    | Yes                             | Redis backend for persisted solver config and order state.                                           | Your local or remote Redis instance.                  |
| `SOLVER_ID`                    | Required after seeding          | Solver config identifier loaded from Redis on later runs. It should match the seeded config.         | Printed by `npm run bootstrap`.                       |
| `ALCHEMY_API_KEY`              | Strongly recommended            | Fills placeholders such as `${ALCHEMY_API_KEY}` inside JSON config RPC URLs.                         | [Alchemy Dashboard](https://dashboard.alchemy.com/)   |
| `COINGECKO_API_KEY`            | Optional                        | Price feed API key for CoinGecko when enabled. Free-tier fallback may still work without it.         | [CoinGecko API](https://www.coingecko.com/en/api)     |
| `JWT_SECRET`                   | Optional unless auth is enabled | Secret for solver auth behavior.                                                                     | Generate locally, for example `openssl rand -hex 32`. |
| `AUTH_PUBLIC_REGISTER_ENABLED` | Optional                        | Enables `/auth/register` for non-admin scopes when auth is enabled.                                  | Local config choice.                                  |

## JSON Config Rendering

The committed JSON config can contain placeholders such as `${ALCHEMY_API_KEY}` and `${VAR:-default}`.

Before the solver starts, `scripts/run-solver.sh` renders the selected JSON config into a temporary file with `scripts/render-config-env.sh`, then starts `solver-service` with `--bootstrap-config <rendered-file>`.

This wrapper is used by both `bootstrap` and `start`, so the same rendering logic applies in both cases.

Manual examples:

```bash
bash scripts/run-solver.sh config/sepolia_base-sepolia.json
bash scripts/run-solver.sh config/sepolia_base-sepolia.json --force-seed
npm run render-config -- config/sepolia_base-sepolia.json
```

## Main Commands

From `packages/my-oif-solver/`:

| Command                              | When to use it                            | What it does                                                                                                                               |
| ------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run bootstrap`                  | First setup or when config changed        | Renders the JSON config, then starts the solver with `--force-seed` so Redis is overwritten with the latest config.                        |
| `npm run start`                      | Normal solver startup                     | Renders the JSON config, then starts the solver without `--force-seed`. If a config already exists in Redis, the solver keeps using it.    |
| `npm run health`                     | Quick health check                        | Calls `GET /health`.                                                                                                                       |
| `npm run assets`                     | Inspect supported assets                  | Calls `GET /api/v1/assets`.                                                                                                                |
| `npm run quotes -- ...`              | Inspect raw quote output                  | Calls `POST /api/v1/quotes`.                                                                                                               |
| `npm run quote-min -- ...`           | Find the minimum viable input size        | Repeatedly probes the quote API.                                                                                                           |
| `npm run doctor -- ...`              | Pre-flight diagnostics                    | Checks quote generation, balance, spender addresses, allowance state, and prints a multi-source tracking preview without opening an order. |
| `npm run approve-permit2 -- ...`     | Before `openFor`                          | Approves the source token for Permit2.                                                                                                     |
| `npm run approve-settler -- ...`     | Before `open`                             | Approves the source token for the source-chain Input Settler.                                                                              |
| `npm run open -- ...`                | User-driven on-chain open                 | The user wallet directly calls `open()` on the source-chain input contract.                                                                |
| `npm run openFor -- ...`             | Solver-assisted API flow                  | The user signs an EIP-712 payload and the solver API submits the order on the user's behalf.                                               |
| `npm run status -- --order-id 0x...` | Track a solver order                      | Calls `GET /api/v1/orders/{id}`.                                                                                                           |
| `npm run refund -- --list`           | Review saved open orders                  | Reads `.oif-orders/` and checks their on-chain status.                                                                                     |
| `npm run refund -- --order-id 0x...` | Refund an expired on-chain `open()` order | Loads a saved order from `.oif-orders/` and sends `refund()`.                                                                              |

Equivalent Moon tasks from the monorepo root:

```bash
moon run my-oif-solver:bootstrap
moon run my-oif-solver:start
```

## Common CLI Parameters

These flags appear on multiple commands:

| Flag                 | Meaning                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `--from-chain`       | Source chain label. Current script aliases include `sepolia` and `base-sepolia`.                    |
| `--to-chain`         | Destination chain label. Must be different from `--from-chain`.                                     |
| `--from-token`       | Source token symbol, currently `USDC` or `EURC`.                                                    |
| `--to-token`         | Destination token symbol, currently `USDC` or `EURC`.                                               |
| `--amount`           | Input amount in the token's smallest unit.                                                          |
| `--min-output`       | Optional minimum output amount in the destination token's smallest unit.                            |
| `--receiver`         | Optional destination receiver. Defaults to the address derived from `USER_PRIVATE_KEY`.             |
| `--wait`             | Poll the solver until the order reaches a terminal state or the timeout is hit.                     |
| `--input-settler`    | Override the source-chain input settler used by `open`.                                             |
| `--spender-address`  | Override the spender for `approve-settler`.                                                         |
| `--auto-approve`     | For `open` and `openFor`, auto-send an exact-amount ERC-20 approval when allowance is insufficient. |
| `--order-id`         | Used by `status` and `refund` to target a specific order.                                           |
| `--order-file`       | Used by `refund` to load a specific saved order file.                                               |
| `--list` / `--prune` | Used by `refund` to list cached orders, optionally deleting files already refunded on-chain.        |

## `npm run open`: Direct User `open()` Flow

Use `open` when you want the user wallet from `USER_PRIVATE_KEY` to call the source-chain Input Settler directly.

High-level flow:

1. The script requests a quote from the solver API.
2. It converts the quoted escrow order into a local `StandardOrder`.
3. It checks the user ERC-20 balance and allowance for the source-chain input settler.
4. If `--auto-approve` is enabled, it sends an approval transaction first.
5. The user wallet sends `open()` on the source chain.
6. After the transaction confirms, the script stores a local record in `.oif-orders/`.
7. If `--wait` is enabled, the script uses a multi-source tracker that combines solver order status, source-chain escrow state, source-chain `Finalised` logs, destination-chain receipt data, destination output-settler log scans, and Hyperlane delivery data when available.

Important detail:

- `open` does **not** build the order completely from scratch without the solver API. It still depends on the solver quote API to obtain the escrow quote, then converts that quote into a local `StandardOrder` before calling `open()`.

Downstream solver behavior:

- The solver's on-chain discovery watches for the newly opened order.
- Once accepted and executable, the solver proceeds through its internal order lifecycle, including fill execution and later settlement / claim / finalization steps depending on the configured settlement path.
- In the solver status model, an order typically progresses through states such as `Created`, `Pending`, `Executing`, `Executed`, optional `PostFilled`, optional `PreClaimed` / `Settled`, and finally `Finalized`.

## `npm run openFor`: Solver API `openFor()` Flow

Use `openFor` when you want the user wallet to sign an EIP-712 authorization and let the solver API handle submission.

High-level flow:

1. The script requests a quote from the solver API.
2. It signs the returned quote payload with `USER_PRIVATE_KEY`.
3. It sends `quoteId + signature` to `POST /api/v1/orders`.
4. The solver service reloads the stored quote, reconstructs the intent, validates the signature, and checks user balance before forwarding the request to off-chain discovery.
5. The solver continues the downstream workflow and submits the on-chain order path on behalf of the user.
6. If `--wait` is enabled, the script uses the same multi-source tracker used by `open`.

Important detail:

- `openFor` is the flow that relies most heavily on the solver API.
- The script does **not** save `.oif-orders/` files for `openFor`.
- This flow can auto-approve Permit2 with `--auto-approve`, and the approval amount is the exact required input amount.

## Balance, Allowance, and Auto-Approve Behavior

### `open`

- Checks source-token balance before sending `open()`.
- Checks source-token allowance against the source-chain input settler.
- Can auto-approve when `--auto-approve` is enabled.
- Auto-approve uses the exact required amount, not `maxUint256`.

### `openFor`

- Checks source-token balance before signing and sending the API request.
- Checks Permit2 allowance on the client side.
- Can auto-approve Permit2 with the exact required amount by using `--auto-approve`.
- The solver API performs a balance validation before continuing order processing.
- That API-side validation does **not** replace the need for the correct Permit2 or token approval setup.

## Escrow Only

This project is configured for the escrow route only.

- The CLI flow now assumes `InputSettlerEscrow`.
- The project-level config no longer carries The Compact addresses.
- `doctor`, `open`, and `openFor` all print Traditional Chinese summaries with decimal-formatted token amounts.

The vendored upstream `lib/oif-solver/` still contains generic Compact / resource-lock support, but this project configuration and CLI flow do not use it.

## `.oif-orders` Local Cache

The local cache directory is:

```bash
packages/my-oif-solver/.oif-orders/
```

Current behavior:

- `npm run open` writes one file per successfully confirmed on-chain `open()` order.
- `npm run refund -- --list` reads all cached files and checks their on-chain order status.
- `npm run refund -- --list --prune` reads all cached files and deletes files already refunded on-chain.
- `npm run refund -- --order-id 0x...` reads the matching cached file.
- `npm run refund -- --order-file /path/to/file.json` reads the specified cached file directly.
- `openFor`, `status`, `quotes`, `health`, `assets`, and `doctor` do not write to `.oif-orders/`.

Each cached order file stores route metadata plus the generated `StandardOrder`, which is why it is required later for `refund()`.

## Tracking Behavior

When `--wait` is enabled, the CLI now combines multiple data sources instead of relying on a single endpoint:

- solver `GET /api/v1/orders/{id}`
- source-chain escrow `orderStatus(orderId)`
- source-chain `Finalised` event scan
- destination-chain fill transaction receipt
- destination output-settler `getLogs` scan for the fill transaction block
- Hyperlane GraphQL delivery status if a mailbox `DispatchId` is found

While waiting, the CLI prints a **segmented** snapshot on each change:

1. `訂單識別`
2. `--- 來源鏈 ---` (escrow status + `Finalised` log probe)
3. `--- solver ---` (solver order status + fill tx metadata when present)
4. `--- 目的鏈 ---` (fill receipt + output settler log scan)
5. `--- Hyperlane ---` (mailbox `DispatchId` + GraphQL view when available)

`npm run doctor` embeds the same structured object under `多來源追蹤預覽` in its JSON report (single payload), so you can diff it without opening an order.

Polling cadence still uses:

- `POLL_INTERVAL_MS`
- `ORDER_TIMEOUT_MS`

Default values come from `.env` or fallback constants:

- `POLL_INTERVAL_MS = 5000`
- `ORDER_TIMEOUT_MS = 600000`

## CLI output examples

These examples are **illustrative** (addresses, hashes, and numbers will match your wallet, solver, and live chain state). They show the **shape** of the output after the CLI entry was moved to `scripts/index.ts`.

### Multi-route smoke loop (same idea as the old `regression.sh`)

Prerequisites: solver reachable at `SOLVER_BASE_URL`, `.env` filled, user has test tokens on both chains.

#### 1. Mode: open (create intent)

**Route A: Sepolia (USDC) -> Base Sepolia (EURC)**

```bash
npm run open -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token EURC --amount 500000 --wait --auto-approve
```

**Route B: Base Sepolia (EURC) -> Sepolia (USDC)**

```bash
npm run open -- --from-chain base-sepolia --to-chain sepolia --from-token EURC --to-token USDC --amount 500000 --wait --auto-approve
```

**Route C: Base Sepolia (USDC) -> Sepolia (EURC)**

```bash
npm run open -- --from-chain base-sepolia --to-chain sepolia --from-token USDC --to-token EURC --amount 500000 --wait --auto-approve
```

**Route D: Sepolia (EURC) -> Base Sepolia (USDC)**

```bash
npm run open -- --from-chain sepolia --to-chain base-sepolia --from-token EURC --to-token USDC --amount 500000 --wait --auto-approve
```

---

#### 2. Mode: openFor (create intent on behalf of another)

**Route A: Sepolia (USDC) -> Base Sepolia (EURC)**

```bash
npm run openFor -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token EURC --amount 500000 --wait --auto-approve
```

**Route B: Base Sepolia (EURC) -> Sepolia (USDC)**

```bash
npm run openFor -- --from-chain base-sepolia --to-chain sepolia --from-token EURC --to-token USDC --amount 500000 --wait --auto-approve
```

**Route C: Base Sepolia (USDC) -> Sepolia (EURC)**

```bash
npm run openFor -- --from-chain base-sepolia --to-chain sepolia --from-token USDC --to-token EURC --amount 500000 --wait --auto-approve
```

**Route D: Sepolia (EURC) -> Base Sepolia (USDC)**

```bash
npm run openFor -- --from-chain sepolia --to-chain base-sepolia --from-token EURC --to-token USDC --amount 500000 --wait --auto-approve
```

### `npm run doctor` (single JSON blob; Traditional Chinese keys + formatted amounts)

```json
{
  "路由": "base-sepolia USDC -> sepolia EURC",
  "QuoteId": "01JQ…",
  "輸入數量": "5 USDC",
  "預估輸出數量": "4.9 EURC",
  "使用者餘額": { "raw": "10000000", "formatted": "10 USDC", "enough": true },
  "Allowances": [
    {
      "標的": "報價提供的 Spender",
      "allowance": "5 USDC",
      "enough": true
    }
  ],
  "訂單摘要": {
    "輸入數量": "5 USDC",
    "StandardOrder": {
      "Inputs": [{ "人類可讀數量": "5 USDC" }],
      "Outputs": [{ "人類可讀數量": "4.9 EURC" }]
    }
  },
  "多來源追蹤預覽": {
    "訂單識別": "0xabc…",
    "來源鏈": {
      "鏈名稱": "Base Sepolia",
      "escrow狀態": { "code": 1, "label": "Deposited" },
      "Finalised事件": null
    },
    "solver": { "訂單狀態": "pending", "fill交易": null },
    "目的鏈": {
      "鏈名稱": "Ethereum Sepolia",
      "fillReceipt": null,
      "OutputSettler掃描": null
    },
    "Hyperlane": null
  }
}
```

### `npm run open` / `npm run openFor` (order preview before submit)

Both commands print a line such as `open 訂單摘要:` / `openFor 訂單摘要:` followed by JSON. The payload mirrors `buildOrderPreviewData()` (Traditional Chinese field names, decimal-formatted amounts, shortened hex for signatures and long calldata).

```json
{
  "模式": "openFor",
  "QuoteId": "01JQ…",
  "輸入數量": "5 USDC",
  "使用者簽章": "0xabcdef1234…dcba",
  "StandardOrder": {
    "Inputs": [{ "人類可讀數量": "5 USDC" }],
    "Outputs": [{ "人類可讀數量": "4.9 EURC" }]
  }
}
```

### `--wait` segmented tracker (stdout while polling)

```text
多來源追蹤摘要:
訂單識別: 0xabc…def
--- 來源鏈 ---
{
  "鏈名稱": "Base Sepolia",
  "escrow狀態": { "code": 1, "label": "Deposited" },
  "Finalised事件": { "blockNumber": "12345", "transactionHash": "0xccc…" }
}
--- solver ---
{
  "訂單狀態": "executed",
  "fill交易": { "hash": "0xbbb…", "status": "confirmed", "timestamp": 1710000000 }
}
--- 目的鏈 ---
{
  "鏈名稱": "Ethereum Sepolia",
  "fillReceipt": { "status": "success", "blockNumber": "999" },
  "OutputSettler掃描": { "blockNumber": "999", "logCount": 2, "topics": ["0xdddd…"] }
}
--- Hyperlane ---
{
  "messageId": "0xeeee…",
  "messageView": { "is_delivered": true }
}
```

## References

- Upstream solver: [openintentsframework/oif-solver](https://github.com/openintentsframework/oif-solver)
- Hyperlane deployments: [Mailbox](https://docs.hyperlane.xyz/docs/reference/addresses/deployments/mailbox), [Interchain Gas Paymaster](https://docs.hyperlane.xyz/docs/reference/addresses/deployments/interchainGasPaymaster)
- Circle faucet: [https://faucet.circle.com/](https://faucet.circle.com/)
