# my-oif-solver-tron

`my-oif-solver-tron` 是 `oif-solver` 的 Tron 包裝層，目標是以最小侵入方式準備
`USDT@TRON(Shasta) <-> USDC@HyperEVM(998)` 的求解流程。

## 目前範圍（1A + 2C + 3A）

- 建立可啟動 wrapper（`config + scripts + env + CLI`）
- 讀取路徑採 JSON-RPC（`eth_chainId` / `eth_getLogs` 等）
- 交易送出路徑預留 Tron 原生廣播模式（`/wallet/*`，後續接到核心）
- 不改動 `lib/oif-solver` submodule 內容（維持唯讀）

## 快速開始

```bash
cd packages/my-oif-solver-tron
cp .env.example .env
npm install
```

先確認 RPC 相容性：

```bash
npm run rpc-probe
```

啟動 solver（第一次建議強制 seed）：

```bash
npm run bootstrap
# 後續
npm run start
```

查健康狀態與資產：

```bash
npm run health
npm run assets
npm run smoke-tron-to-hyperevm
npm run smoke-hyperevm-to-tron
npm run e2e-staged-gates
```

## Tron 位址工具

支援 Base58Check / 41-hex / EVM 20-byte 轉換：

```bash
npm run tron-address -- --base58 TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs
npm run tron-address -- --hex 41A614F803B6FD780986A42C78EC9C7F77E6DED13C
```

## 重要設定說明

- `config/tron_hyperevm-testnet.json` 已放入：
  - Tron Shasta / HyperEVM testnet chain 基本資訊
  - Hyperlane mailbox（依官方 deployment 表）
  - 您提供的 Tron / HyperEVM 合約地址
- `TRON_INPUT_ORACLE_ADDRESS`、`TRON_OUTPUT_ORACLE_ADDRESS` 預設暫用
  `Hyperlane Adapter` 值，建議以實際 Oracle 合約再覆蓋。
- `TRON_HYPERLANE_IGP_ADDRESS` / `HYPEREVM_HYPERLANE_IGP_ADDRESS`
  預設為 `0x0`，正式跑 PostFill 前請覆蓋。
- `account.implementations.local_tron_shasta` 會使用
  `SOLVER_PRIVATE_KEY_TRON_SHASTA`，供 `tron_native` 的 per-network signer 使用。
- `TRON_CHAIN_IDS` 建議固定為 `2494104990`，可避免自動判斷時混入非 Tron 鏈；
  若用 `config/tron_hyperevm-testnet.json` 啟動且未設定，`run-solver.sh` 會自動補預設值。
- `settlement.hyperlane` 新增 delivery 監控參數，可控制跨鏈事件追蹤穩定性：
  - `delivery_check_timeout_ms`
  - `delivery_retry_max_retries`
  - `delivery_retry_initial_backoff_ms`
  - `delivery_retry_max_backoff_ms`
- `npm run smoke-tron-to-hyperevm` 會驗證：
  - `/assets` 是否同時出現 `USDT@TRON` 與 `USDC@HyperEVM`
  - `tron_base58` 欄位是否存在於 Tron token 回應
  - 雙鏈 `eth_chainId` 是否與預期一致
  - 若有提供 `SMOKE_OWNER_ADDRESS`，額外驗證 Tron nonce / balance / allowance read path
- `npm run smoke-hyperevm-to-tron` 會做反向路徑前置檢查（資產映射 + 雙鏈 chainId）
- `npm run live-e2e-tron-to-hyperevm` 會執行：
  - `POST /quotes`（TRON USDT -> HyperEVM USDC）
  - 使用 `USER_PRIVATE_KEY` 進行 EIP-712 簽章
  - `POST /orders`
  - `GET /orders/{id}` 持續追蹤直到可接受狀態或超時
- `npm run e2e-staged-gates` 會依環境變數執行分階段驗收：
  - Stage 1（必跑）：`TRON -> HyperEVM` smoke，且可要求 live e2e
  - Stage 2（可選）：`HyperEVM -> TRON` smoke（預設關閉）

## 注意事項

- 目前 `oif-solver` 核心 delivery 仍是 EVM-only；Tron 寫交易要走原生 API。
- 此 wrapper 先確保可啟動、可渲染配置、可做鏈相容探針與地址治理。
- 後續核心改造建議在 `oif-solver-oneleo/` 進行，再回收 submodule 更新。

## Live E2E 執行手冊（Step 8）

1. 啟動 solver（建議先 `npm run bootstrap` 一次）。
2. 在 `.env` 設定：
   - `USER_PRIVATE_KEY`（測試錢包私鑰）
   - `SMOKE_OWNER_ADDRESS`（可填 `T...` 或 `0x...`）
   - `LIVE_INPUT_AMOUNT`（預設 `1000000`，即 1 USDT）
3. 確認 `USER_PRIVATE_KEY` 對應地址有足夠 `TRX + USDT`。
4. 執行：
   - 單向 live：`npm run live-e2e-tron-to-hyperevm`
   - 分階段驗收：`npm run e2e-staged-gates`

建議 gate 參數：

- `E2E_REQUIRE_STAGE1_LIVE=true`：Stage 1 必須跑 live e2e（建議 CI 關閉，手動驗收開啟）
- `E2E_ENABLE_STAGE2=false`：先關閉反向驗收，等第二階段再開

## 參考

- TRON Accounts & Address Format: <https://developers.tron.network/docs/account>
- TRON JSON-RPC Overview: <https://developers.tron.network/reference/json-rpc-api-overview>
- TRON `eth_getLogs`: <https://developers.tron.network/reference/eth_getlogs>
- TRON broadcast API: <https://developers.tron.network/reference/broadcasttransaction>
- Hyperlane Mailbox deployments: <https://docs.hyperlane.xyz/docs/reference/addresses/deployments/mailbox>
- Circle USDC addresses: <https://developers.circle.com/stablecoins/usdc-contract-addresses>
- Circle HyperCore contracts: <https://developers.circle.com/cctp/references/hypercore-contract-addresses#coredepositwallet-testnet>
