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

## 注意事項

- 目前 `oif-solver` 核心 delivery 仍是 EVM-only；Tron 寫交易要走原生 API。
- 此 wrapper 先確保可啟動、可渲染配置、可做鏈相容探針與地址治理。
- 後續核心改造建議在 `oif-solver-oneleo/` 進行，再回收 submodule 更新。

## 參考

- TRON Accounts & Address Format: <https://developers.tron.network/docs/account>
- TRON JSON-RPC Overview: <https://developers.tron.network/reference/json-rpc-api-overview>
- TRON `eth_getLogs`: <https://developers.tron.network/reference/eth_getlogs>
- TRON broadcast API: <https://developers.tron.network/reference/broadcasttransaction>
- Hyperlane Mailbox deployments: <https://docs.hyperlane.xyz/docs/reference/addresses/deployments/mailbox>
- Circle USDC addresses: <https://developers.circle.com/stablecoins/usdc-contract-addresses>
- Circle HyperCore contracts: <https://developers.circle.com/cctp/references/hypercore-contract-addresses#coredepositwallet-testnet>
