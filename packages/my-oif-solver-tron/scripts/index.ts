import { config as loadEnv } from "dotenv";
import { expand } from "dotenv-expand";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

expand(loadEnv({ path: join(process.cwd(), ".env") }));

const SOLVER_BASE_URL =
  process.env.SOLVER_BASE_URL ?? "http://127.0.0.1:3000/api/v1";
const TRON_SHASTA_RPC_URL =
  process.env.TRON_SHASTA_RPC_URL ?? "https://api.shasta.trongrid.io/jsonrpc";
const HYPEREVM_TESTNET_RPC_URL =
  process.env.HYPEREVM_TESTNET_RPC_URL ??
  "https://rpc.hyperliquid-testnet.xyz/evm";
const TRON_CHAIN_ID = Number(process.env.TRON_CHAIN_ID ?? "2494104990");
const HYPEREVM_CHAIN_ID = Number(process.env.HYPEREVM_CHAIN_ID ?? "998");
const TRON_USDT_ADDRESS =
  process.env.TRON_USDT_ADDRESS ?? "0x42A1E39AEFA49290F2B3F9ED688D7CECF86CD6E0";
const HYPEREVM_USDC_ADDRESS =
  process.env.HYPEREVM_USDC_ADDRESS ??
  "0x2B3370eE501B4a559b57D449569354196457D8Ab";
const TRON_INPUT_SETTLER_ADDRESS =
  process.env.TRON_INPUT_SETTLER_ADDRESS ??
  "0x16f1c40c13634f4a97d8004453ed86b7189583bc";
const HYPEREVM_OUTPUT_SETTLER_ADDRESS =
  process.env.HYPEREVM_OUTPUT_SETTLER_ADDRESS ??
  "0xe241df14e36c639610e6f564a74b0bc9350dbc60";
const SMOKE_OWNER_ADDRESS =
  process.env.SMOKE_OWNER_ADDRESS ?? process.env.TRON_TEST_OWNER_ADDRESS;
const LIVE_INPUT_AMOUNT = process.env.LIVE_INPUT_AMOUNT ?? "1000000";
const LIVE_POLL_INTERVAL_MS = Number(
  process.env.LIVE_POLL_INTERVAL_MS ?? "5000",
);
const LIVE_TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? "900000");
const E2E_REQUIRE_STAGE1_LIVE =
  (process.env.E2E_REQUIRE_STAGE1_LIVE ?? "true").toLowerCase() === "true";
const E2E_ENABLE_STAGE2 =
  (process.env.E2E_ENABLE_STAGE2 ?? "false").toLowerCase() === "true";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map(
  [...BASE58_ALPHABET].map((char, index) => [char, index] as const),
);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case "health":
      await handleHealth();
      return;
    case "assets":
      await handleAssets();
      return;
    case "rpc-probe":
      await handleRpcProbe();
      return;
    case "tron-address":
      handleTronAddress(flags);
      return;
    case "smoke-tron-to-hyperevm":
      await handleSmokeTronToHyperEvm();
      return;
    case "smoke-hyperevm-to-tron":
      await handleSmokeHyperEvmToTron();
      return;
    case "live-e2e-tron-to-hyperevm":
      await handleLiveE2ETronToHyperEvm();
      return;
    case "e2e-staged-gates":
      await handleE2EStagedGates();
      return;
    default:
      printHelp();
  }
}

function printHelp() {
  console.log(`Usage:
  npm run health
  npm run assets
  npm run rpc-probe
  npm run tron-address -- --base58 T...
  npm run tron-address -- --hex 41...
  npm run smoke-tron-to-hyperevm
  npm run smoke-hyperevm-to-tron
  npm run live-e2e-tron-to-hyperevm
  npm run e2e-staged-gates

Notes:
  - rpc-probe verifies "read via JSON-RPC" and reports if transaction
    broadcasting via eth_sendRawTransaction is unavailable on Shasta.
  - tron-address converts Base58Check <-> hex(41 prefix) <-> EVM(0x20-byte).
  - smoke-tron-to-hyperevm validates TRON -> HyperEVM prerequisites.
  - live-e2e-tron-to-hyperevm runs /quotes -> /orders -> /orders/{id} tracking.
`);
}

async function handleHealth() {
  const origin = SOLVER_BASE_URL.replace(/\/api\/v1\/?$/, "");
  const url = `${origin}/health`;
  const response = await fetch(url);
  const body = await response.text();
  console.log(`${response.status} ${response.statusText}`);
  console.log(body || "(empty body)");
}

async function handleAssets() {
  const response = await fetch(`${SOLVER_BASE_URL}/assets`);
  const body = await response.text();
  console.log(`${response.status} ${response.statusText}`);
  console.log(body || "(empty body)");
}

async function handleRpcProbe() {
  const tronChainId = await jsonRpc(TRON_SHASTA_RPC_URL, "eth_chainId", []);
  const tronSendRawProbe = await jsonRpc(
    TRON_SHASTA_RPC_URL,
    "eth_sendRawTransaction",
    ["0xdeadbeef"],
  );
  const hyperChainId = await jsonRpc(
    HYPEREVM_TESTNET_RPC_URL,
    "eth_chainId",
    [],
  );

  console.log(
    JSON.stringify(
      {
        tronShasta: {
          rpc: TRON_SHASTA_RPC_URL,
          eth_chainId: tronChainId,
          eth_sendRawTransaction_probe: tronSendRawProbe,
          guidance:
            "若 eth_sendRawTransaction 不可用，請改走 Tron 原生 /wallet 廣播 API（2C 模式）。",
        },
        hyperEvmTestnet: {
          rpc: HYPEREVM_TESTNET_RPC_URL,
          eth_chainId: hyperChainId,
        },
      },
      null,
      2,
    ),
  );
}

async function handleSmokeTronToHyperEvm() {
  const assets = (await fetchJson(`${SOLVER_BASE_URL}/assets`)) as {
    networks?: Record<
      string,
      {
        chain_id: number;
        assets: Array<{
          symbol: string;
          address: string;
          tron_base58?: string;
        }>;
      }
    >;
  };
  const tronNetwork = assets.networks?.[String(TRON_CHAIN_ID)];
  const hyperNetwork = assets.networks?.[String(HYPEREVM_CHAIN_ID)];
  if (!tronNetwork || !hyperNetwork) {
    throw new Error(
      `assets 缺少目標鏈設定，TRON=${TRON_CHAIN_ID} HyperEVM=${HYPEREVM_CHAIN_ID}`,
    );
  }
  const tronUsdt = tronNetwork.assets.find((a) => a.symbol === "USDT");
  const hyperUsdc = hyperNetwork.assets.find((a) => a.symbol === "USDC");
  if (!tronUsdt || !hyperUsdc) {
    throw new Error("assets 缺少 USDT@TRON 或 USDC@HyperEVM");
  }
  if (!tronUsdt.tron_base58) {
    throw new Error("assets 回應缺少 tron_base58，請確認 API 回應層已更新。");
  }

  const tronChainIdResp = await jsonRpc(TRON_SHASTA_RPC_URL, "eth_chainId", []);
  const hyperChainIdResp = await jsonRpc(
    HYPEREVM_TESTNET_RPC_URL,
    "eth_chainId",
    [],
  );
  const actualTronChainId = Number.parseInt(
    String((tronChainIdResp as { result?: string }).result ?? "0x0"),
    16,
  );
  const actualHyperChainId = Number.parseInt(
    String((hyperChainIdResp as { result?: string }).result ?? "0x0"),
    16,
  );

  let nonceHex: string | undefined;
  let usdtBalanceHex: string | undefined;
  let allowanceHex: string | undefined;
  if (SMOKE_OWNER_ADDRESS) {
    const ownerEvm = normalizeToEvm20Hex(SMOKE_OWNER_ADDRESS);
    nonceHex = String(
      (
        (await jsonRpc(TRON_SHASTA_RPC_URL, "eth_getTransactionCount", [
          ownerEvm,
          "pending",
        ])) as { result?: string }
      ).result ?? "0x0",
    );
    usdtBalanceHex = String(
      (
        (await jsonRpc(TRON_SHASTA_RPC_URL, "eth_call", [
          {
            to: normalizeToEvm20Hex(TRON_USDT_ADDRESS),
            data: `0x70a08231${ownerEvm.slice(2).padStart(64, "0")}`,
          },
          "latest",
        ])) as { result?: string }
      ).result ?? "0x0",
    );
    const spender = normalizeToEvm20Hex(TRON_INPUT_SETTLER_ADDRESS);
    allowanceHex = String(
      (
        (await jsonRpc(TRON_SHASTA_RPC_URL, "eth_call", [
          {
            to: normalizeToEvm20Hex(TRON_USDT_ADDRESS),
            data: `0xdd62ed3e${ownerEvm.slice(2).padStart(64, "0")}${spender
              .slice(2)
              .padStart(64, "0")}`,
          },
          "latest",
        ])) as { result?: string }
      ).result ?? "0x0",
    );
  }

  console.log(
    JSON.stringify(
      {
        solver_assets_check: {
          tron_chain_id: TRON_CHAIN_ID,
          hyperevm_chain_id: HYPEREVM_CHAIN_ID,
          tron_usdt: tronUsdt,
          hyperevm_usdc: hyperUsdc,
        },
        rpc_chain_ids: {
          tron_expected: TRON_CHAIN_ID,
          tron_actual: actualTronChainId,
          hyperevm_expected: HYPEREVM_CHAIN_ID,
          hyperevm_actual: actualHyperChainId,
        },
        tron_read_path_probe: SMOKE_OWNER_ADDRESS
          ? {
              owner: SMOKE_OWNER_ADDRESS,
              nonce_hex: nonceHex,
              usdt_balance_hex: usdtBalanceHex,
              allowance_hex: allowanceHex,
            }
          : {
              skipped: true,
              reason:
                "未提供 SMOKE_OWNER_ADDRESS/TRON_TEST_OWNER_ADDRESS，略過 nonce/balance/allowance 檢查。",
            },
      },
      null,
      2,
    ),
  );
}

async function handleSmokeHyperEvmToTron() {
  const assets = (await fetchJson(`${SOLVER_BASE_URL}/assets`)) as {
    networks?: Record<
      string,
      {
        chain_id: number;
        assets: Array<{
          symbol: string;
          address: string;
          tron_base58?: string;
        }>;
      }
    >;
  };
  const tronNetwork = assets.networks?.[String(TRON_CHAIN_ID)];
  const hyperNetwork = assets.networks?.[String(HYPEREVM_CHAIN_ID)];
  if (!tronNetwork || !hyperNetwork) {
    throw new Error(
      `assets 缺少目標鏈設定，TRON=${TRON_CHAIN_ID} HyperEVM=${HYPEREVM_CHAIN_ID}`,
    );
  }
  const tronUsdt = tronNetwork.assets.find((a) => a.symbol === "USDT");
  const hyperUsdc = hyperNetwork.assets.find((a) => a.symbol === "USDC");
  if (!tronUsdt || !hyperUsdc) {
    throw new Error("assets 缺少 USDT@TRON 或 USDC@HyperEVM");
  }
  const tronChainIdResp = await jsonRpc(TRON_SHASTA_RPC_URL, "eth_chainId", []);
  const hyperChainIdResp = await jsonRpc(
    HYPEREVM_TESTNET_RPC_URL,
    "eth_chainId",
    [],
  );
  const actualTronChainId = Number.parseInt(
    String((tronChainIdResp as { result?: string }).result ?? "0x0"),
    16,
  );
  const actualHyperChainId = Number.parseInt(
    String((hyperChainIdResp as { result?: string }).result ?? "0x0"),
    16,
  );
  console.log(
    JSON.stringify(
      {
        direction: "HyperEVM->TRON",
        solver_assets_check: {
          tron_chain_id: TRON_CHAIN_ID,
          hyperevm_chain_id: HYPEREVM_CHAIN_ID,
          tron_usdt: tronUsdt,
          hyperevm_usdc: hyperUsdc,
        },
        rpc_chain_ids: {
          tron_expected: TRON_CHAIN_ID,
          tron_actual: actualTronChainId,
          hyperevm_expected: HYPEREVM_CHAIN_ID,
          hyperevm_actual: actualHyperChainId,
        },
      },
      null,
      2,
    ),
  );
}

async function handleE2EStagedGates() {
  const report: Record<string, unknown> = {
    stage1: { direction: "TRON->HyperEVM", smoke: "pending", live: "pending" },
    stage2: { direction: "HyperEVM->TRON", smoke: "skipped" },
  };
  await handleSmokeTronToHyperEvm();
  (report.stage1 as Record<string, unknown>).smoke = "passed";
  if (E2E_REQUIRE_STAGE1_LIVE) {
    await handleLiveE2ETronToHyperEvm();
    (report.stage1 as Record<string, unknown>).live = "passed";
  } else {
    (report.stage1 as Record<string, unknown>).live = "skipped";
  }
  if (E2E_ENABLE_STAGE2) {
    await handleSmokeHyperEvmToTron();
    (report.stage2 as Record<string, unknown>).smoke = "passed";
  }
  console.log(JSON.stringify({ staged_gates: report }, null, 2));
}

async function handleLiveE2ETronToHyperEvm() {
  const userPrivateKey = process.env.USER_PRIVATE_KEY;
  if (!userPrivateKey) {
    throw new Error("缺少 USER_PRIVATE_KEY，無法進行 live e2e 簽章。");
  }
  const account = privateKeyToAccount(normalizePrivateKey(userPrivateKey));
  const ownerEvm = normalizeToEvm20Hex(account.address);
  const userInterop = toInteropAddress(TRON_CHAIN_ID, ownerEvm);
  const receiverInterop = toInteropAddress(HYPEREVM_CHAIN_ID, ownerEvm);
  const inputAssetInterop = toInteropAddress(
    TRON_CHAIN_ID,
    normalizeToEvm20Hex(TRON_USDT_ADDRESS),
  );
  const outputAssetInterop = toInteropAddress(
    HYPEREVM_CHAIN_ID,
    normalizeToEvm20Hex(HYPEREVM_USDC_ADDRESS),
  );
  const quoteRequest = {
    user: userInterop,
    intent: {
      intentType: "oif-swap",
      inputs: [
        {
          user: userInterop,
          asset: inputAssetInterop,
          amount: LIVE_INPUT_AMOUNT,
        },
      ],
      outputs: [{ receiver: receiverInterop, asset: outputAssetInterop }],
      swapType: "exact-input",
      originSubmission: { mode: "user", schemes: ["permit2"] },
    },
    supportedTypes: ["oif-escrow-v0"],
  };
  const quoteResponse = (await postJson(
    `${SOLVER_BASE_URL}/quotes`,
    quoteRequest,
  )) as {
    quotes?: Array<{
      quoteId?: string;
      order?: {
        payload?: {
          domain?: Record<string, unknown>;
          types?: Record<string, unknown>;
          primaryType?: string;
          message?: Record<string, unknown>;
        };
      };
    }>;
  };
  const quote = quoteResponse.quotes?.[0];
  const quoteId = quote?.quoteId;
  if (!quoteId) {
    throw new Error("quotes 回應缺少 quoteId，無法進行下單。");
  }
  const payload = quote.order?.payload;
  if (
    !payload?.types ||
    !payload.primaryType ||
    !payload.domain ||
    !payload.message
  ) {
    throw new Error("quotes 回應缺少可簽章的 EIP-712 payload。");
  }
  const signature = (await (
    account.signTypedData as unknown as (
      input: Record<string, unknown>,
    ) => Promise<string>
  )({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message,
  })) as `0x${string}`;
  const orderResp = (await postJson(`${SOLVER_BASE_URL}/orders`, {
    quoteId,
    signature,
  })) as { orderId?: string; status?: string; message?: string | null };
  const orderId = orderResp.orderId;
  if (!orderId) {
    throw new Error(
      `orders 回應缺少 orderId，status=${String(orderResp.status ?? "unknown")} message=${String(orderResp.message ?? "")}`,
    );
  }
  const tracking = await pollOrderTracking(orderId);
  console.log(
    JSON.stringify(
      {
        direction: "TRON->HyperEVM",
        quote_id: quoteId,
        order_id: orderId,
        user_evm20: ownerEvm,
        tracking,
      },
      null,
      2,
    ),
  );
}

function handleTronAddress(flags: Record<string, string | boolean>) {
  const base58 = stringFlag(flags, "base58");
  const hex = stringFlag(flags, "hex");

  if (!base58 && !hex) {
    throw new Error('請提供 "--base58" 或 "--hex" 其中之一。');
  }
  if (base58 && hex) {
    throw new Error('請只提供一種格式： "--base58" 或 "--hex"。');
  }

  if (base58) {
    const tronHex = tronBase58ToHex(base58);
    console.log(
      JSON.stringify(
        {
          input_base58: base58,
          tron_hex_41: tronHex,
          evm_0x20bytes: tron41HexToEvmHex(tronHex),
        },
        null,
        2,
      ),
    );
    return;
  }

  const normalizedHex = normalizeTronHex41(hex!);
  console.log(
    JSON.stringify(
      {
        input_hex_41: normalizedHex,
        evm_0x20bytes: tron41HexToEvmHex(normalizedHex),
        base58check: tronHexToBase58(normalizedHex),
      },
      null,
      2,
    ),
  );
}

async function jsonRpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  const data = (await response.json()) as Record<string, unknown>;
  return data;
}

export function tronBase58ToHex(base58: string): string {
  const decoded = base58Decode(base58);
  if (decoded.length < 5) {
    throw new Error("Base58Check 長度無效。");
  }
  const payload = decoded.subarray(0, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);
  const expected = doubleSha256(payload).subarray(0, 4);
  if (!equalBytes(checksum, expected)) {
    throw new Error("Base58Check checksum 驗證失敗。");
  }
  if (payload.length !== 21 || payload[0] !== 0x41) {
    throw new Error("TRON 位址 payload 必須是 21 bytes 且以 0x41 開頭。");
  }
  return payload.toString("hex").toUpperCase();
}

export function tronHexToBase58(tronHex41: string): string {
  const payload = Buffer.from(normalizeTronHex41(tronHex41), "hex");
  const checksum = doubleSha256(payload).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

export function tron41HexToEvmHex(tronHex41: string): string {
  const normalized = normalizeTronHex41(tronHex41);
  return `0x${normalized.slice(2)}`;
}

export function normalizeTronHex41(value: string): string {
  const clean = value.replace(/^0x/i, "").toUpperCase();
  if (!/^[0-9A-F]+$/.test(clean)) {
    throw new Error("HEX 格式錯誤。");
  }
  if (clean.length !== 42 || !clean.startsWith("41")) {
    throw new Error("TRON HEX 位址必須是 42 hex chars 且以 41 開頭。");
  }
  return clean;
}

function doubleSha256(input: Uint8Array): Buffer {
  const first = createHash("sha256").update(input).digest();
  return createHash("sha256").update(first).digest();
}

function base58Decode(value: string): Buffer {
  let num = 0n;
  for (const char of value) {
    const digit = BASE58_MAP.get(char);
    if (digit === undefined) {
      throw new Error(`Base58 字元無效: ${char}`);
    }
    num = num * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num % 256n));
    num /= 256n;
  }
  bytes.reverse();

  let leadingZeroCount = 0;
  for (const char of value) {
    if (char === "1") {
      leadingZeroCount += 1;
    } else {
      break;
    }
  }
  return Buffer.from([...new Array(leadingZeroCount).fill(0), ...bytes]);
}

function base58Encode(buffer: Uint8Array): string {
  let num = BigInt(`0x${Buffer.from(buffer).toString("hex") || "0"}`);
  let encoded = "";
  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    num /= 58n;
  }

  let leadingZeroCount = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      leadingZeroCount += 1;
    } else {
      break;
    }
  }
  return `${"1".repeat(leadingZeroCount)}${encoded || "1"}`;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function stringFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeToEvm20Hex(value: string): string {
  if (value.startsWith("T")) {
    return tron41HexToEvmHex(tronBase58ToHex(value));
  }
  const clean = value.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`無效地址格式: ${value}`);
  }
  if (clean.length === 42 && clean.toLowerCase().startsWith("41")) {
    return `0x${clean.slice(2)}`.toLowerCase();
  }
  if (clean.length !== 40) {
    throw new Error(`地址長度不符 20 bytes: ${value}`);
  }
  return `0x${clean}`.toLowerCase();
}

export function normalizePrivateKey(value: string): `0x${string}` {
  const clean = value.trim();
  const withPrefix = clean.startsWith("0x") ? clean : `0x${clean}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error("USER_PRIVATE_KEY 格式錯誤，需為 64 hex chars。");
  }
  return withPrefix as `0x${string}`;
}

export function toInteropAddress(chainId: number, evm20Hex: string): string {
  const addr = normalizeToEvm20Hex(evm20Hex).replace(/^0x/i, "").toLowerCase();
  const chainHex = Number(chainId).toString(16);
  const padded = chainHex.length % 2 === 0 ? chainHex : `0${chainHex}`;
  const chainRef = padded.length === 0 ? "00" : padded;
  const chainRefLen = (chainRef.length / 2).toString(16).padStart(2, "0");
  return `0x00010000${chainRefLen}${chainRef}14${addr}`;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${text || url}`,
    );
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

async function pollOrderTracking(orderId: string): Promise<{
  final_status: string;
  attempts: number;
  elapsed_ms: number;
}> {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < LIVE_TIMEOUT_MS) {
    attempts += 1;
    const orderResp = (await fetchJson(
      `${SOLVER_BASE_URL}/orders/${orderId}`,
    )) as {
      order?: { status?: unknown };
    };
    const status = orderResp.order?.status;
    const normalized = normalizeOrderStatus(status);
    if (normalized === "failed") {
      throw new Error(`order tracking 失敗：${JSON.stringify(status)}`);
    }
    if (
      ["executed", "postfilled", "settled", "preclaimed", "finalized"].includes(
        normalized,
      )
    ) {
      return {
        final_status: normalized,
        attempts,
        elapsed_ms: Date.now() - start,
      };
    }
    await sleep(LIVE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `order tracking timeout: ${orderId} 超過 ${LIVE_TIMEOUT_MS}ms`,
  );
}

export function normalizeOrderStatus(status: unknown): string {
  if (typeof status === "string") {
    return status.toLowerCase();
  }
  if (status && typeof status === "object") {
    if ("failed" in (status as Record<string, unknown>)) {
      return "failed";
    }
  }
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
