# my-oif-solver

Wrapper around the Rust [`openintentsframework/oif-solver`](https://github.com/openintentsframework/oif-solver) in `lib/oif-solver/`, plus TypeScript CLI utilities in `scripts/index.ts` for quotes, approvals, `open`, `openFor`, refunds, and order status checks.

## Prerequisites

```bash
brew install node rust redis jq
```

## Setup

```bash
cd packages/my-oif-solver
cp .env.example .env
# fill in values — see table below
npm install
```

## `.env` Variables

| Variable                             | Required                 | Purpose                                                                                       | Where to get                                                                    |
| ------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `SOLVER_PRIVATE_KEY`                 | **Yes**                  | Solver wallet; signs on-chain transactions after an order is accepted                         | Export from a wallet you control                                                |
| `USER_PRIVATE_KEY`                   | Yes for CLI flows        | User wallet used by `open`, `openFor`, `refund`, `quotes`, and `doctor`                       | Export from a wallet you control                                                |
| `REDIS_URL`                          | **Yes**                  | Redis backend for solver config and order state                                               | Your local (`redis://localhost:6379`) or remote Redis instance                  |
| `SOLVER_ID`                          | After first bootstrap    | Config identifier loaded from Redis on subsequent runs; must match the seeded value           | Printed by `npm run bootstrap`                                                  |
| `ALCHEMY_API_KEY`                    | Strongly recommended     | Replaces `${ALCHEMY_API_KEY}` placeholders in RPC URLs inside `config/*.json`                 | [dashboard.alchemy.com](https://dashboard.alchemy.com/)                         |
| `SOLVER_BASE_URL`                    | Usually yes              | Base URL for the solver HTTP API (must end with `/api/v1`)                                    | Default: `http://127.0.0.1:3000/api/v1`                                         |
| `SEPOLIA_RPC_URL`                    | No                       | Override the default public Sepolia RPC endpoint                                              | [dashboard.alchemy.com](https://dashboard.alchemy.com/) or any Sepolia RPC      |
| `BASE_SEPOLIA_RPC_URL`               | No                       | Override the default public Base Sepolia RPC endpoint                                         | [dashboard.alchemy.com](https://dashboard.alchemy.com/) or any Base Sepolia RPC |
| `DEPLOYMENT_PRIVATE_KEY`             | No                       | Used during contract deployment flows only                                                    | Export from a wallet you control                                                |
| `COINGECKO_API_KEY`                  | No                       | Price feed for CoinGecko; free-tier fallback may still work                                   | [coingecko.com/en/api](https://www.coingecko.com/en/api)                        |
| `JWT_SECRET`                         | No (unless auth enabled) | Signing secret for solver API auth                                                            | `openssl rand -hex 32`                                                          |
| `AUTH_PUBLIC_REGISTER_ENABLED`       | No                       | Enables `/auth/register` for non-admin scopes                                                 | Local config choice                                                             |
| `POLL_INTERVAL_MS`                   | No                       | Initial polling interval in ms for `--wait` (default: `5000`)                                 | —                                                                               |
| `MAX_POLL_INTERVAL_MS`               | No                       | Maximum polling interval after exponential backoff (default: `30000`)                         | —                                                                               |
| `ORDER_TIMEOUT_MS`                   | No                       | Total polling timeout in ms before giving up (default: `600000`)                              | —                                                                               |
| `OUTPUT_FILLED_SCAN_LOOKBACK_BLOCKS` | No                       | Max blocks to look back when scanning destination chain for `OutputFilled` (default: `40000`) | —                                                                               |
| `HYPERLANE_POST_FILL_SCAN_BLOCKS`    | No                       | Blocks after the fill tx to scan for the Hyperlane `Dispatch` event (default: `200`)          | —                                                                               |

> Do not commit `.env`.

## JSON Config Rendering

The committed JSON config (`config/sepolia_base-sepolia.json`) can contain env-var placeholders such as `${ALCHEMY_API_KEY}` and `${VAR:-default}`.

Before the solver starts, `scripts/run-solver.sh` renders the config into a temp file with `scripts/render-config-env.sh`, then starts `solver-service --bootstrap-config <rendered-file>`. This applies to both `bootstrap` and `start`.

```bash
# Render only (inspect output without starting)
npm run render-config -- config/sepolia_base-sepolia.json
```

## Commands

From `packages/my-oif-solver/`:

| Command                            | When to use                        | What it does                                                                  |
| ---------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| `npm run bootstrap`                | First setup or after config change | Renders config, starts solver with `--force-seed` (overwrites Redis)          |
| `npm run start`                    | Normal startup                     | Renders config, starts solver without `--force-seed`                          |
| `npm run health`                   | Quick check                        | `GET /health`                                                                 |
| `npm run assets`                   | Inspect supported tokens           | `GET /api/v1/assets`                                                          |
| `npm run quotes -- …`              | Inspect raw quote output           | `POST /api/v1/quotes`                                                         |
| `npm run quote-min -- …`           | Find minimum viable input size     | Repeatedly probes the quote API                                               |
| `npm run doctor -- …`              | Pre-flight diagnostics             | Checks quote, balance, allowances, and prints a multi-source tracking preview |
| `npm run approve-permit2 -- …`     | Before `openFor`                   | Approves the source token for Permit2                                         |
| `npm run approve-settler -- …`     | Before `open`                      | Approves the source token for the source-chain Input Settler                  |
| `npm run open -- …`                | User-driven on-chain flow          | User wallet calls `open()` on the Input Settler directly                      |
| `npm run openFor -- …`             | Solver-assisted API flow           | User signs EIP-712; solver API submits the order                              |
| `npm run status -- --order-id 0x…` | Track an existing order            | `GET /api/v1/orders/{id}`                                                     |
| `npm run refund -- --list`         | Review cached open orders          | Reads `.oif-orders/` and checks on-chain status                               |
| `npm run refund -- --order-id 0x…` | Refund an expired `open()` order   | Sends `refund()` using a cached order file                                    |

## Common CLI Parameters

| Flag                 | Required / Recommended / Optional | Meaning                                                                       |
| -------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `--from-chain`       | **Required**                      | Source chain: `sepolia` or `base-sepolia`                                     |
| `--to-chain`         | **Required**                      | Destination chain (must differ from `--from-chain`)                           |
| `--from-token`       | **Required**                      | Source token symbol: `USDC` or `EURC`                                         |
| `--to-token`         | **Required**                      | Destination token symbol: `USDC` or `EURC`                                    |
| `--amount`           | **Required**                      | Input amount in the token's smallest unit (e.g. `500000` = 0.5 USDC)          |
| `--wait`             | Recommended                       | Poll until the order reaches a terminal state or timeout                      |
| `--auto-approve`     | Recommended                       | Auto-send an exact-amount ERC-20 approval when allowance is insufficient      |
| `--min-output`       | Optional                          | Minimum acceptable output amount in the destination token's smallest unit     |
| `--receiver`         | Optional                          | Destination address (defaults to the address derived from `USER_PRIVATE_KEY`) |
| `--order-id`         | Required for `status` / `refund`  | Target a specific order by ID                                                 |
| `--order-file`       | Optional for `refund`             | Load a specific cached order file path                                        |
| `--list` / `--prune` | Optional for `refund`             | List cached orders; `--prune` also deletes already-refunded files             |
| `--input-settler`    | Optional                          | Override the source-chain Input Settler address used by `open`                |
| `--spender-address`  | Optional                          | Override the spender address used by `approve-settler`                        |

## `npm run open` — Direct User `open()` Flow

The user wallet from `USER_PRIVATE_KEY` calls `open()` on the source-chain Input Settler directly.

**Flow:** quote → convert to `StandardOrder` → check balance + allowance → (optional approval) → `open()` → save `.oif-orders/` record → (optional `--wait` tracking)

```bash
# Minimal
npm run open -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token EURC --amount 500000

# Recommended: wait for completion, auto-approve if needed
npm run open -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token EURC --amount 500000 --wait --auto-approve
npm run open -- --from-chain base-sepolia --to-chain sepolia --from-token EURC --to-token USDC --amount 500000 --wait --auto-approve
npm run open -- --from-chain base-sepolia --to-chain sepolia --from-token USDC --to-token EURC --amount 500000 --wait --auto-approve
npm run open -- --from-chain sepolia --to-chain base-sepolia --from-token EURC --to-token USDC --amount 500000 --wait --auto-approve
```

> `open` still calls the solver quote API to obtain the escrow quote before calling `open()`.

## `npm run openFor` — Solver API `openFor()` Flow

The user signs an EIP-712 payload; the solver API reconstructs and submits the order on the user's behalf.

**Flow:** quote → EIP-712 sign → `POST /api/v1/orders` with `quoteId + signature` → solver submits on-chain → (optional `--wait` tracking)

```bash
npm run openFor -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token EURC --amount 500000 --wait --auto-approve
npm run openFor -- --from-chain base-sepolia --to-chain sepolia --from-token EURC --to-token USDC --amount 500000 --wait --auto-approve
npm run openFor -- --from-chain base-sepolia --to-chain sepolia --from-token USDC --to-token EURC --amount 500000 --wait --auto-approve
npm run openFor -- --from-chain sepolia --to-chain base-sepolia --from-token EURC --to-token USDC --amount 500000 --wait --auto-approve
```

> `openFor` does **not** write `.oif-orders/` files. Use `--auto-approve` for the Permit2 allowance.

## `npm run doctor` — Pre-flight Diagnostics

```bash
npm run doctor -- --from-chain base-sepolia --to-chain sepolia --from-token USDC --to-token EURC --amount 500000
```

**Sample output (abbreviated)**

```json
{
  "路由": "base-sepolia USDC → sepolia EURC",
  "QuoteId": "01JQ…",
  "輸入數量": "5 USDC",
  "預估輸出數量": "4.9 EURC",
  "使用者餘額": { "formatted": "10 USDC", "enough": true },
  "Allowances": [
    { "標的": "報價提供的 Spender", "allowance": "5 USDC", "enough": true }
  ],
  "多來源追蹤預覽": {
    "來源鏈": { "escrow狀態": { "code": 1, "label": "Deposited" } },
    "solver": { "訂單狀態": "pending" },
    "目的鏈": { "fillReceipt": null },
    "Hyperlane": null
  }
}
```

## `npm run refund`

```bash
npm run refund -- --list                          # list cached orders and check on-chain status
npm run refund -- --list --prune                  # also delete files already refunded on-chain
npm run refund -- --order-id 0xabc…              # refund by order ID (reads from .oif-orders/)
npm run refund -- --order-file /path/to/file.json # refund from an explicit file path
```

## `.oif-orders/` Local Cache

`npm run open` writes one file per confirmed on-chain `open()` order. Each file stores route metadata plus the `StandardOrder` needed for `refund()`.

`openFor`, `openFor`, `status`, `quotes`, `health`, `assets`, and `doctor` do **not** write to `.oif-orders/`.

## `--wait` Tracking

When `--wait` is passed, the CLI combines multiple data sources and updates the terminal on every state change:

- Solver `GET /api/v1/orders/{id}`
- Source-chain escrow `orderStatus(orderId)`
- Source-chain `Finalised` event scan
- Destination-chain fill tx receipt (extracted from the receipt logs directly once `fillTxHash` is known)
- Hyperlane `Dispatch` event from the PostFill block range (filtered by output oracle sender), with `DispatchId` fallback for cross-version compatibility

Polling uses **exponential backoff** (from `POLL_INTERVAL_MS` up to `MAX_POLL_INTERVAL_MS`), resetting on phase transitions. Total timeout is `ORDER_TIMEOUT_MS`.

**Sample `--wait` output (success)**

```
訂單監控  0x34012959…58693d2fe7
══════════════════════════════════════════════════════
  [✓]   ① OPEN / openFor     已確認
  [✓]   ② FILL               已確認
  [✓] ③ SUBMIT (Hyperlane)  已確認
  [~] ④ FINALIZE           等待來源鏈結算確認...
──────────────────────────────────────────────────────

  [ Solver API ]
    訂單狀態: settled
    Fill 交易: 0x8356…339e

  [ ① 來源鏈 ] Base Sepolia
    InputSettler 狀態: Claimed

  [ ② 目的鏈 ] Ethereum Sepolia
    OutputFilled 事件: block 10715492 tx 0x8356…339e
    Fill 收據: success (block 10715492)

  [ ③ Hyperlane 跨鏈訊息 ]
    DispatchId: 0xeeee…

══════════════════════════════════════════════════════
  [✓] 訂單流程已全部確認完成！
  確認來源: InputSettler 鏈上: Claimed
  ⏱  開單至結算總耗時: 1 分 41 秒
```

**Sample `--wait` output (failure)**

```
  [✓]   ① OPEN / openFor     已確認
  [✗]   ② FILL               失敗
  [ ] ③ SUBMIT (Hyperlane)  (等待 Fill 完成後啟動)
  [ ] ④ FINALIZE           (等待跨鏈訊息後啟動)

  [ Solver API ]
    訂單狀態: failed:Fill:Failed to handle order execution: …nonce too low…

  [✗] 訂單流程已失敗！
  確認來源: Solver API (failed:Fill:…)
  ⏱  開單至結算總耗時: 44 秒
```

## Escrow Only

This project uses the **escrow route** exclusively (`InputSettlerEscrow`). The Compact / resource-lock path in `lib/oif-solver/` is not used by this project's config or CLI.

## References

- Upstream solver: [openintentsframework/oif-solver](https://github.com/openintentsframework/oif-solver)
- Hyperlane Mailbox deployments: [docs.hyperlane.xyz/docs/reference/addresses/deployments/mailbox](https://docs.hyperlane.xyz/docs/reference/addresses/deployments/mailbox)
- Hyperlane IGP deployments: [docs.hyperlane.xyz/docs/reference/addresses/deployments/interchainGasPaymaster](https://docs.hyperlane.xyz/docs/reference/addresses/deployments/interchainGasPaymaster)
- Circle EURC/USDC testnet faucet: [faucet.circle.com](https://faucet.circle.com/)
