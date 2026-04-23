import { encodeAddress } from "@wonderland/interop-addresses";
import { config as loadEnv } from "dotenv";
import { expand } from "dotenv-expand";
import {
  mkdir,
  readdir,
  readFile as readTextFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  http,
  isAddress,
  keccak256,
  maxUint256,
  parseAbi,
  recoverAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

expand(loadEnv({ path: join(process.cwd(), ".env") }));

type ChainKey = "sepolia" | "base-sepolia";
type TokenKey = "USDC" | "EURC";

type TypeField = {
  name: string;
  type: string;
};

type SwapContext = {
  fromChainKey: ChainKey;
  toChainKey: ChainKey;
  fromTokenKey: TokenKey;
  toTokenKey: TokenKey;
  amount: string;
};

type OrderPayload = {
  domain: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
  types?: Record<string, TypeField[]>;
};

type StandardOrderOutput = {
  oracle: Hex;
  settler: Hex;
  chainId: bigint;
  token: Hex;
  amount: bigint;
  recipient: Hex;
  callbackData: Hex;
  context: Hex;
};

type StandardOrder = {
  user: Address;
  nonce: bigint;
  originChainId: bigint;
  expires: number;
  fillDeadline: number;
  inputOracle: Address;
  inputs: [bigint, bigint][];
  outputs: StandardOrderOutput[];
};

type TokenMetadata = {
  symbol: string;
  address: Address;
  decimals: number;
};

type StoredOpenOrderRecord = {
  version: 1;
  savedAt: string;
  orderId: Hex;
  quoteId: string;
  openTxHash: Hex;
  fromChainKey: ChainKey;
  toChainKey: ChainKey;
  fromTokenKey: TokenKey;
  toTokenKey: TokenKey;
  fromTokenAddress: Address;
  toTokenAddress: Address;
  inputSettlerAddress: Address;
  quoteSpender: Address;
  standardOrder: StandardOrder;
};

type QuoteOrder = {
  type: string;
  payload: OrderPayload;
  metadata?: Record<string, unknown>;
};

type QuoteResponse = {
  quoteId: string;
  order: QuoteOrder;
  validUntil?: number;
  eta?: number;
  provider?: string;
  preview: {
    inputs: Array<{ amount?: string; asset: string }>;
    outputs: Array<{ amount?: string; asset: string }>;
  };
};

type QuotesApiResponse = {
  quotes: QuoteResponse[];
};

type OrderApiResponse = {
  orderId?: string | null;
  status: string;
  message?: string | null;
};

type SolverOrderRecord = {
  id?: string;
  status: string | { failed: [string, string] };
  updatedAt: number;
  fillTransaction?: {
    hash: string;
    status: string;
    timestamp: number;
  } | null;
};

type AssetsApiResponse = {
  networks: Record<
    string,
    {
      chain_id: number;
      name?: string | null;
      assets: Array<{
        address: Address;
        symbol: string;
        decimals: number;
      }>;
    }
  >;
};

type NetworkAssetsResponse = {
  chain_id: number;
  name?: string | null;
  assets: Array<{
    address: Address;
    symbol: string;
    decimals: number;
  }>;
};

const SOLVER_BASE_URL =
  process.env.SOLVER_BASE_URL ?? "http://127.0.0.1:3000/api/v1";

function solverHttpOrigin(): string {
  return SOLVER_BASE_URL.replace(/\/api\/v1\/?$/, "");
}
/** 初始輪詢間隔（ms）；可透過環境變數 POLL_INTERVAL_MS 覆寫 */
const BASE_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "5000");
/** 指數退避上限（ms）；可透過環境變數 MAX_POLL_INTERVAL_MS 覆寫 */
const MAX_POLL_INTERVAL_MS = Number(
  process.env.MAX_POLL_INTERVAL_MS ?? "30000",
);
const ORDER_TIMEOUT_MS = Number(process.env.ORDER_TIMEOUT_MS ?? "600000");
/**
 * OutputFilled 事件掃描回溯區塊數（預設 40000）。
 * 可透過環境變數 OUTPUT_FILLED_SCAN_LOOKBACK_BLOCKS 覆寫。
 * 當能從 open tx 估算目的鏈起始區塊時，此值作為最大回溯上限。
 */
const OUTPUT_FILLED_SCAN_LOOKBACK_BLOCKS = BigInt(
  process.env.OUTPUT_FILLED_SCAN_LOOKBACK_BLOCKS ?? "40000",
);
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const EIP712_DOMAIN_TYPEHASH = keccak256(
  stringValueToHex(
    "EIP712Domain(string name,uint256 chainId,address verifyingContract)",
  ),
);
const TOKEN_PERMISSIONS_TYPEHASH = keccak256(
  stringValueToHex("TokenPermissions(address token,uint256 amount)"),
);
const MANDATE_OUTPUT_TYPEHASH = keccak256(
  stringValueToHex(
    "MandateOutput(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes callbackData,bytes context)",
  ),
);
const PERMIT2_WITNESS_TYPEHASH = keccak256(
  stringValueToHex(
    "Permit2Witness(address user,uint32 expires,address inputOracle,MandateOutput[] outputs)MandateOutput(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes callbackData,bytes context)",
  ),
);
const PERMIT2_ORDER_TYPEHASH = keccak256(
  stringValueToHex(
    "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,Permit2Witness witness)MandateOutput(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes callbackData,bytes context)Permit2Witness(address user,uint32 expires,address inputOracle,MandateOutput[] outputs)TokenPermissions(address token,uint256 amount)",
  ),
);

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const INPUT_SETTLER_ABI = parseAbi([
  "function open((address user,uint256 nonce,uint256 originChainId,uint32 expires,uint32 fillDeadline,address inputOracle,uint256[2][] inputs,(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes callbackData,bytes context)[] outputs) order)",
  "function orderIdentifier((address user,uint256 nonce,uint256 originChainId,uint32 expires,uint32 fillDeadline,address inputOracle,uint256[2][] inputs,(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes callbackData,bytes context)[] outputs) order) view returns (bytes32)",
  "function orderStatus(bytes32 orderId) view returns (uint8)",
  "function refund((address user,uint256 nonce,uint256 originChainId,uint32 expires,uint32 fillDeadline,address inputOracle,uint256[2][] inputs,(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes callbackData,bytes context)[] outputs) order)",
]);
const INPUT_SETTLER_EVENTS_ABI = parseAbi([
  "event Finalised(bytes32 indexed orderId, bytes32 solver, bytes32 destination)",
]);
const HYPERLANE_MAILBOX_EVENTS_ABI = parseAbi([
  "event DispatchId(bytes32 indexed messageId)",
]);
/**
 * Full Dispatch event from Hyperlane Mailbox.
 * The PostFill tx (submitted by the solver AFTER the fill) calls the output oracle,
 * which internally calls Mailbox.dispatch() → emits this event.
 * sender = output oracle on destination chain; messageId is in data (not indexed).
 */
const HYPERLANE_MAILBOX_DISPATCH_ABI = parseAbi([
  "event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes32 messageId, bytes message)",
])[0];
const OUTPUT_SETTLER_FILL_ABI = parseAbi([
  "event OutputFilled(bytes32 indexed orderId, bytes32 solver, uint32 timestamp, (bytes32 oracle, bytes32 settler, uint256 chainId, bytes32 token, uint256 amount, bytes32 recipient, bytes callbackData, bytes context) output, uint256 finalAmount)",
]);
/**
 * Keccak256 of the canonical OutputFilled event signature.
 * Used to scan receipt logs without a full getLogs call.
 */
const OUTPUT_FILLED_TOPIC0 = keccak256(
  stringValueToHex(
    "OutputFilled(bytes32,bytes32,uint32,(bytes32,bytes32,uint256,bytes32,uint256,bytes32,bytes,bytes),uint256)",
  ),
) as Hex;

const CHAIN_CONFIG: Record<
  ChainKey,
  {
    chainId: number;
    displayName: string;
    rpcUrl: string;
    explorerBaseUrl: string;
    viemChain: typeof sepolia | typeof baseSepolia;
  }
> = {
  sepolia: {
    chainId: 11155111,
    displayName: "Ethereum Sepolia",
    rpcUrl:
      process.env.SEPOLIA_RPC_URL ??
      "https://ethereum-sepolia-rpc.publicnode.com",
    explorerBaseUrl: "https://sepolia.etherscan.io",
    viemChain: sepolia,
  },
  "base-sepolia": {
    chainId: 84532,
    displayName: "Base Sepolia",
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    explorerBaseUrl: "https://sepolia.basescan.org",
    viemChain: baseSepolia,
  },
};

const FALLBACK_TOKEN_MAP: Record<number, Record<TokenKey, Address>> = {
  11155111: {
    EURC: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4",
    USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
  84532: {
    EURC: "0x808456652fdb597867f38412077A9182bf77359F",
    USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};
const FALLBACK_TOKEN_DECIMALS: Record<TokenKey, number> = {
  USDC: 6,
  EURC: 6,
};
/** Matches `config/sepolia_base-sepolia.json` deployed InputSettlerEscrow (same bytecode on both testnets). */
const INPUT_SETTLER_MAP: Record<number, Address> = {
  11155111: "0x8429Ba4323b2131aA7FB1947E20dB479030c12c1",
  84532: "0x8429Ba4323b2131aA7FB1947E20dB479030c12c1",
};
const OUTPUT_SETTLER_MAP: Record<number, Address> = {
  11155111: "0x07C262912467800B0AA9B2E1bd44DC8ceCfB90Eb",
  84532: "0x07C262912467800B0AA9B2E1bd44DC8ceCfB90Eb",
};
const HYPERLANE_MAILBOX_MAP: Record<number, Address> = {
  11155111: "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766",
  84532: "0x6966b0E55883d49BFB24539356a2f8A673E02039",
};
/**
 * Output oracle addresses on each destination chain.
 * The PostFill tx calls the output oracle, which dispatches to Hyperlane.
 * Used to filter Dispatch events by sender in findMailboxDispatchIdAfterFill.
 */
const OUTPUT_ORACLE_MAP: Record<number, Address> = {
  11155111: "0x0BeC172d10d76aa41c0c7bD14185cfeD25742f4A",
  84532: "0x58Ce84331d53268430586dB120c0463859fd02Fc",
};
/**
 * How many blocks after the fill block to scan for the Hyperlane Dispatch event.
 * The PostFill tx is submitted shortly after the fill, so 200 blocks is conservative.
 * Can be overridden via HYPERLANE_POST_FILL_SCAN_BLOCKS env var.
 */
const HYPERLANE_POST_FILL_SCAN_BLOCKS = BigInt(
  process.env.HYPERLANE_POST_FILL_SCAN_BLOCKS ?? "200",
);
const ORDER_CACHE_DIR = join(process.cwd(), ".oif-orders");

type OrderTrackingContext = {
  orderId: string;
  sourceChainKey: ChainKey;
  destinationChainKey: ChainKey;
  inputSettlerAddress: Address;
  outputSettlerAddress: Address;
  standardOrder: StandardOrder;
  openTxHash?: Hex;
};

type OrderPreviewData = Record<string, unknown>;

type OrderPhase = "open" | "fill" | "submit" | "finalize";

type SettledResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const flags = parseFlags(args);

  switch (command) {
    case "health":
      await handleHealth();
      return;
    case "quotes":
      await handleQuotes(flags);
      return;
    case "assets":
      await handleAssets();
      return;
    case "approve-permit2":
      await handleApprovePermit2(flags);
      return;
    case "approve-settler":
      await handleApproveSettler(flags);
      return;
    case "doctor":
    case "simulate-open":
      await handleDoctor(flags);
      return;
    case "open":
      await handleOpen(flags);
      return;
    case "quote-min":
      await handleQuoteMin(flags);
      return;
    case "refund":
      await handleRefund(flags);
      return;
    case "status":
      await handleStatus(flags);
      return;
    case "openFor":
      await handleOpenFor(flags);
      return;
    default:
      throw new Error(`未知指令: ${command}`);
  }
}

async function handleHealth() {
  const origin = solverHttpOrigin();
  const url = `${origin}/health`;
  console.log(`GET ${url}`);
  const response = await fetch(url);
  const text = await response.text();
  console.log(`${response.status} ${response.statusText}`);
  console.log(text || "(empty body)");
}

async function handleQuotes(flags: Record<string, string | boolean>) {
  const fromChainKey = parseChain(requiredFlag(flags, "from-chain"));
  const toChainKey = parseChain(requiredFlag(flags, "to-chain"));
  const fromTokenKey = parseToken(requiredFlag(flags, "from-token"));
  const toTokenKey = parseToken(requiredFlag(flags, "to-token"));
  const amount = requiredFlag(flags, "amount");
  const minOutput = stringFlag(flags, "min-output");
  const account = getUserAccount();

  if (fromChainKey === toChainKey) {
    throw new Error("Cross-chain routes only (from-chain ≠ to-chain).");
  }

  const fromChain = CHAIN_CONFIG[fromChainKey];
  const toChain = CHAIN_CONFIG[toChainKey];
  const receiver = resolveReceiver(
    stringFlag(flags, "receiver"),
    account.address,
  );
  const fromToken = await resolveTokenMetadata(fromChain.chainId, fromTokenKey);
  const toToken = await resolveTokenMetadata(toChain.chainId, toTokenKey);
  const requestBody = buildQuoteRequest({
    fromChainId: fromChain.chainId,
    toChainId: toChain.chainId,
    accountAddress: account.address,
    receiver,
    fromTokenAddress: fromToken.address,
    toTokenAddress: toToken.address,
    amount,
    minOutput,
  });

  const swapContext: SwapContext = {
    fromChainKey,
    toChainKey,
    fromTokenKey,
    toTokenKey,
    amount,
  };

  const quoteResponse = await requestQuoteWithGuidance(
    requestBody,
    swapContext,
  );
  console.log(JSON.stringify(quoteResponse, null, 2));
}

/** Print encoded order + predicted orderId so the user can broadcast `open()` manually on-chain. */
async function handleAssets() {
  const assets = await fetchJson<AssetsApiResponse>(
    `${SOLVER_BASE_URL}/assets`,
  );
  console.log(JSON.stringify(assets, null, 2));
}

async function handleApprovePermit2(flags: Record<string, string | boolean>) {
  const chainKey = parseChain(requiredFlag(flags, "from-chain"));
  const tokenKey = parseToken(requiredFlag(flags, "token"));
  const rawAmount = stringFlag(flags, "amount") ?? "max";
  const account = getUserAccount();
  const chain = CHAIN_CONFIG[chainKey];
  const tokenAddress = await resolveTokenAddress(chain.chainId, tokenKey);
  const approveAmount = rawAmount === "max" ? maxUint256 : BigInt(rawAmount);

  const publicClient = createPublicClient({
    chain: chain.viemChain,
    transport: http(chain.rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: chain.viemChain,
    transport: http(chain.rpcUrl),
  });

  const currentAllowance = (await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, PERMIT2_ADDRESS],
  })) as bigint;

  console.log(`來源鏈: ${chain.displayName}`);
  console.log(`Token: ${tokenKey} (${tokenAddress})`);
  console.log(`Owner: ${account.address}`);
  console.log(`Permit2: ${PERMIT2_ADDRESS}`);
  console.log(`目前 allowance: ${currentAllowance.toString()}`);

  if (currentAllowance >= approveAmount) {
    console.log("目前 allowance 已足夠，無需再次 approve。");
    return;
  }

  const txHash = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [PERMIT2_ADDRESS, approveAmount],
  });

  console.log(`送出 approve 交易: ${txHash}`);
  console.log(`Explorer: ${chain.explorerBaseUrl}/tx/${txHash}`);

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("approve 已確認。");
}

async function handleApproveSettler(flags: Record<string, string | boolean>) {
  const chainKey = parseChain(requiredFlag(flags, "from-chain"));
  const tokenKey = parseToken(requiredFlag(flags, "token"));
  const rawAmount = stringFlag(flags, "amount") ?? "max";
  const account = getUserAccount();
  const chain = CHAIN_CONFIG[chainKey];
  const tokenAddress = await resolveTokenAddress(chain.chainId, tokenKey);
  const inputSettlerAddress = resolveSettlerSpenderForManualApprove(
    flags,
    chain.chainId,
  );
  const approveAmount = rawAmount === "max" ? maxUint256 : BigInt(rawAmount);

  const publicClient = createPublicClient({
    chain: chain.viemChain,
    transport: http(chain.rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: chain.viemChain,
    transport: http(chain.rpcUrl),
  });

  const currentAllowance = (await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, inputSettlerAddress],
  })) as bigint;

  console.log(`來源鏈: ${chain.displayName}`);
  console.log(`Token: ${tokenKey} (${tokenAddress})`);
  console.log(`Owner: ${account.address}`);
  console.log(`Input Settler: ${inputSettlerAddress}`);
  console.log(`目前 allowance: ${currentAllowance.toString()}`);

  if (currentAllowance >= approveAmount) {
    console.log("目前 allowance 已足夠，無需再次 approve。");
    return;
  }

  const txHash = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [inputSettlerAddress, approveAmount],
  });

  console.log(`送出 approve 交易: ${txHash}`);
  console.log(`Explorer: ${chain.explorerBaseUrl}/tx/${txHash}`);

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("approve 已確認。");
}

async function handleQuoteMin(flags: Record<string, string | boolean>) {
  const fromChainKey = parseChain(requiredFlag(flags, "from-chain"));
  const toChainKey = parseChain(requiredFlag(flags, "to-chain"));
  const fromTokenKey = parseToken(requiredFlag(flags, "from-token"));
  const toTokenKey = parseToken(requiredFlag(flags, "to-token"));
  const amount = requiredFlag(flags, "amount");
  const minOutput = stringFlag(flags, "min-output");
  const account = getUserAccount();

  if (fromChainKey === toChainKey) {
    throw new Error("此指令只支援跨鏈探測，來源鏈與目標鏈不可相同。");
  }

  const fromChain = CHAIN_CONFIG[fromChainKey];
  const toChain = CHAIN_CONFIG[toChainKey];
  const receiver = resolveReceiver(
    stringFlag(flags, "receiver"),
    account.address,
  );
  const fromToken = await resolveTokenMetadata(fromChain.chainId, fromTokenKey);
  const toToken = await resolveTokenMetadata(toChain.chainId, toTokenKey);
  const requestBody = buildQuoteRequest({
    fromChainId: fromChain.chainId,
    toChainId: toChain.chainId,
    accountAddress: account.address,
    receiver,
    fromTokenAddress: fromToken.address,
    toTokenAddress: toToken.address,
    amount,
    minOutput,
  });

  console.log("探測最小可行輸入量中...");
  const result = await findMinimumViableQuote(requestBody, BigInt(amount));

  if (!result.minimumAmount || !result.response) {
    throw new Error(
      "無法估出最小可行輸入量，請改用更大的起始 amount 再試一次。",
    );
  }

  const quote = pickEscrowQuote(result.response.quotes);
  console.log(
    JSON.stringify(
      {
        route: `${fromChainKey} ${fromTokenKey} -> ${toChainKey} ${toTokenKey}`,
        requestedStartAmount: amount,
        minimumViableAmount: result.minimumAmount,
        previewOutputAmount: quote.preview.outputs[0]?.amount ?? "unknown",
        quoteId: quote.quoteId,
        validUntil: quote.validUntil ?? null,
        eta: quote.eta ?? null,
      },
      null,
      2,
    ),
  );
}

async function handleDoctor(flags: Record<string, string | boolean>) {
  const fromChainKey = parseChain(requiredFlag(flags, "from-chain"));
  const toChainKey = parseChain(requiredFlag(flags, "to-chain"));
  const fromTokenKey = parseToken(requiredFlag(flags, "from-token"));
  const toTokenKey = parseToken(requiredFlag(flags, "to-token"));
  const amount = requiredFlag(flags, "amount");
  const minOutput = stringFlag(flags, "min-output");
  const account = getUserAccount();

  if (fromChainKey === toChainKey) {
    throw new Error("此指令只支援跨鏈檢查，來源鏈與目標鏈不可相同。");
  }

  const fromChain = CHAIN_CONFIG[fromChainKey];
  const toChain = CHAIN_CONFIG[toChainKey];
  const receiver = resolveReceiver(
    stringFlag(flags, "receiver"),
    account.address,
  );
  const fromToken = await resolveTokenMetadata(fromChain.chainId, fromTokenKey);
  const toToken = await resolveTokenMetadata(toChain.chainId, toTokenKey);
  const requestBody = buildQuoteRequest({
    fromChainId: fromChain.chainId,
    toChainId: toChain.chainId,
    accountAddress: account.address,
    receiver,
    fromTokenAddress: fromToken.address,
    toTokenAddress: toToken.address,
    amount,
    minOutput,
  });
  const swapContext: SwapContext = {
    fromChainKey,
    toChainKey,
    fromTokenKey,
    toTokenKey,
    amount,
  };

  console.log("執行 dry-run 檢查中...");
  const quoteResponse = await requestQuoteWithGuidance(
    requestBody,
    swapContext,
  );
  const quote = pickEscrowQuote(quoteResponse.quotes);
  const standardOrder = buildStandardOrderFromEscrowQuote(quote.order);
  const quoteSpender = addressValue(
    quote.order.payload.message.spender,
    "quote.order.payload.message.spender",
  );
  const totalInputAmount = computeTotalInputAmount(standardOrder);

  const publicClient = createPublicClient({
    chain: fromChain.viemChain,
    transport: http(fromChain.rpcUrl),
  });
  const currentBalance = (await publicClient.readContract({
    address: fromToken.address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  const inputSettlerAddress = resolveOpenInputSettlerAddress(
    flags,
    fromChain.chainId,
    quoteSpender,
  );
  const orderId = (await publicClient.readContract({
    address: inputSettlerAddress,
    abi: INPUT_SETTLER_ABI,
    functionName: "orderIdentifier",
    args: [standardOrder],
  })) as Hex;

  const spenderChecks = await Promise.all(
    buildAllowanceTargetsForDoctor(fromChain.chainId, quoteSpender).map(
      async (target) => ({
        label: target.label,
        address: target.address,
        allowance: (await publicClient.readContract({
          address: fromToken.address,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [account.address, target.address],
        })) as bigint,
      }),
    ),
  );

  let simulation: { ok: true } | { ok: false; error: string };
  try {
    await (
      publicClient as unknown as {
        simulateContract(args: unknown): Promise<unknown>;
      }
    ).simulateContract({
      address: inputSettlerAddress,
      abi: INPUT_SETTLER_ABI,
      functionName: "open",
      args: [standardOrder],
      account: account.address,
    });
    simulation = { ok: true };
  } catch (error) {
    simulation = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const orderPreview = buildOrderPreviewData({
    actionLabel: "open",
    sourceChainName: fromChain.displayName,
    destinationChainName: toChain.displayName,
    fromToken,
    toToken,
    receiver,
    standardOrder,
    quoteId: quote.quoteId,
    quoteType: quote.order.type,
    quoteSpender,
  });
  const trackingSummary = await buildTrackingSnapshot({
    orderId,
    sourceChainKey: fromChainKey,
    destinationChainKey: toChainKey,
    inputSettlerAddress,
    outputSettlerAddress: OUTPUT_SETTLER_MAP[toChain.chainId],
    standardOrder,
  });

  console.log(
    JSON.stringify(
      buildDoctorReportData({
        route: `${fromChainKey} ${fromTokenKey} -> ${toChainKey} ${toTokenKey}`,
        quoteId: quote.quoteId,
        quoteSpender,
        configuredSettlerFallback: INPUT_SETTLER_MAP[fromChain.chainId] ?? null,
        totalInputAmount,
        previewOutputAmount: quote.preview.outputs[0]?.amount ?? "unknown",
        fromToken,
        toToken,
        orderPreview,
        balance: currentBalance,
        allowances: spenderChecks.map((item) => ({
          ...item,
          enough: item.allowance >= totalInputAmount,
        })),
        simulation,
        trackingSummary,
      }),
      null,
      2,
    ),
  );
}

async function handleRefund(flags: Record<string, string | boolean>) {
  if (flags.list || flags.prune) {
    await handleRefundList({ prune: Boolean(flags.prune) });
    return;
  }

  const record = await loadStoredOrderRecord(flags);
  const chain = CHAIN_CONFIG[record.fromChainKey];
  const account = getUserAccount();
  const now = Math.floor(Date.now() / 1000);

  if (now <= record.standardOrder.expires) {
    throw new Error(
      `訂單尚未到期，expires=${record.standardOrder.expires}，還需等待 ${record.standardOrder.expires - now} 秒。`,
    );
  }

  const publicClient = createPublicClient({
    chain: chain.viemChain,
    transport: http(chain.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: chain.viemChain,
    transport: http(chain.rpcUrl),
  });

  const currentStatus = await fetchOnchainOrderStatus(
    publicClient,
    record.inputSettlerAddress,
    record.orderId,
  );

  console.log(`orderId: ${record.orderId}`);
  console.log(`來源鏈: ${chain.displayName}`);
  console.log(`Input Settler: ${record.inputSettlerAddress}`);
  console.log(`鏈上狀態: ${currentStatus.label}`);

  if (currentStatus.label === "Refunded") {
    console.log("此訂單已在鏈上退款，略過。");
    return;
  }

  const txHash = await walletClient.writeContract({
    address: record.inputSettlerAddress,
    abi: INPUT_SETTLER_ABI,
    functionName: "refund",
    args: [record.standardOrder],
  });

  console.log(`refund tx: ${txHash}`);
  console.log(`Explorer: ${chain.explorerBaseUrl}/tx/${txHash}`);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("refund 已確認。");
}

async function handleRefundList(options?: { prune?: boolean }) {
  await mkdir(ORDER_CACHE_DIR, { recursive: true });
  const entries = (await readdir(ORDER_CACHE_DIR))
    .filter((name) => name.endsWith(".json"))
    .sort();

  const now = Math.floor(Date.now() / 1000);
  const prune = Boolean(options?.prune);
  const rows = await Promise.all(
    entries.map(async (name) => {
      const raw = await readTextFile(join(ORDER_CACHE_DIR, name), "utf8");
      const record = JSON.parse(raw, reviveBigIntJson) as StoredOpenOrderRecord;
      const secondsUntilExpiry = record.standardOrder.expires - now;
      const chain = CHAIN_CONFIG[record.fromChainKey];
      const publicClient = createPublicClient({
        chain: chain.viemChain,
        transport: http(chain.rpcUrl),
      });
      const onchainStatus = await fetchOnchainOrderStatus(
        publicClient,
        record.inputSettlerAddress,
        record.orderId,
      );
      return {
        orderId: record.orderId,
        route: `${record.fromChainKey} ${record.fromTokenKey} -> ${record.toChainKey} ${record.toTokenKey}`,
        expires: record.standardOrder.expires,
        secondsUntilExpiry,
        refundable:
          secondsUntilExpiry <= 0 &&
          onchainStatus.label !== "Refunded" &&
          onchainStatus.label !== "Claimed",
        onchainOrderStatus: onchainStatus.label,
        quoteId: record.quoteId,
        openTxHash: record.openTxHash,
        orderFile: join(ORDER_CACHE_DIR, name),
      };
    }),
  );

  const prunedOrderFiles: string[] = [];
  if (prune) {
    for (const row of rows) {
      if (row.onchainOrderStatus !== "Refunded") {
        continue;
      }
      await unlink(row.orderFile);
      prunedOrderFiles.push(row.orderFile);
    }
  }

  const visibleRows = rows.filter(
    (row) => row.onchainOrderStatus !== "Refunded",
  );
  if (!prune) {
    console.log(JSON.stringify(visibleRows, null, 2));
    return;
  }

  console.log(
    JSON.stringify(
      {
        rows: visibleRows,
        pruned: {
          count: prunedOrderFiles.length,
          orderFiles: prunedOrderFiles,
        },
      },
      null,
      2,
    ),
  );
}

async function fetchOnchainOrderStatus(
  publicClient: any,
  inputSettlerAddress: Address,
  orderId: Hex,
) {
  const rawStatus = await publicClient.readContract({
    address: inputSettlerAddress,
    abi: INPUT_SETTLER_ABI,
    functionName: "orderStatus",
    args: [orderId],
  });

  const code = Number(rawStatus);
  const label =
    code === 0
      ? "None"
      : code === 1
        ? "Deposited"
        : code === 2
          ? "Claimed"
          : code === 3
            ? "Refunded"
            : `Unknown(${code})`;

  return { code, label };
}

function computeTotalInputAmount(standardOrder: StandardOrder) {
  return standardOrder.inputs.reduce(
    (sum, [, inputAmount]) => sum + inputAmount,
    0n,
  );
}

function summarizeHex(value: Hex, visible = 10) {
  if (value.length <= visible * 2 + 2) {
    return value;
  }
  return `${value.slice(0, 2 + visible)}...${value.slice(-4)}`;
}

function summarizeCalldata(value: Hex) {
  if (value === "0x") {
    return value;
  }
  if (value.length <= 14) {
    return value;
  }
  return `${value.slice(0, 13)}...`;
}

function bigintTokenIdToAddress(value: bigint) {
  const hex = value.toString(16).padStart(40, "0");
  return `0x${hex}` as Address;
}

function bytes32ToAddressMaybe(value: Hex) {
  if (!value.startsWith("0x") || value.length !== 66) {
    return undefined;
  }
  const prefix = value.slice(2, 26);
  if (!/^0+$/u.test(prefix)) {
    return undefined;
  }
  const address = `0x${value.slice(-40)}`;
  return isAddress(address) ? (address as Address) : undefined;
}

function normalizeOrderIdHex(orderId: string) {
  if (orderId.startsWith("0x") && orderId.length === 66) {
    return orderId as Hex;
  }
  if (!orderId.startsWith("0x") && orderId.length === 64) {
    return `0x${orderId}` as Hex;
  }
  return undefined;
}

function formatAmountWithDecimals(
  rawAmount: bigint,
  metadata: Pick<TokenMetadata, "symbol" | "decimals">,
) {
  const formatted = formatUnits(rawAmount, metadata.decimals);
  return `${formatted} ${metadata.symbol}`;
}

function describeStandardOrder(
  standardOrder: StandardOrder,
  args: {
    sourceToken: TokenMetadata;
    destinationToken: TokenMetadata;
  },
) {
  return {
    使用者地址: standardOrder.user,
    Nonce: standardOrder.nonce.toString(),
    來源鏈ID: standardOrder.originChainId.toString(),
    訂單到期時間: standardOrder.expires,
    Fill截止時間: standardOrder.fillDeadline,
    InputOracle: standardOrder.inputOracle,
    Inputs: standardOrder.inputs.map(([token, amount], index) => ({
      項次: index + 1,
      TokenAddress: bigintTokenIdToAddress(token),
      Amount: amount.toString(),
      人類可讀數量: formatAmountWithDecimals(amount, args.sourceToken),
    })),
    Outputs: standardOrder.outputs.map((output, index) => ({
      項次: index + 1,
      Oracle: summarizeHex(output.oracle),
      OracleAddress推測: bytes32ToAddressMaybe(output.oracle) ?? null,
      Settler: summarizeHex(output.settler),
      SettlerAddress推測: bytes32ToAddressMaybe(output.settler) ?? null,
      目的鏈ID: output.chainId.toString(),
      Token: summarizeHex(output.token),
      TokenAddress推測: bytes32ToAddressMaybe(output.token) ?? null,
      Amount: output.amount.toString(),
      人類可讀數量: formatAmountWithDecimals(
        output.amount,
        args.destinationToken,
      ),
      Recipient: summarizeHex(output.recipient),
      RecipientAddress推測: bytes32ToAddressMaybe(output.recipient) ?? null,
      CallbackData: summarizeCalldata(output.callbackData),
      Context: summarizeCalldata(output.context),
    })),
  };
}

export function buildOrderPreviewData(args: {
  actionLabel: "open" | "openFor";
  sourceChainName: string;
  destinationChainName: string;
  fromToken: TokenMetadata;
  toToken: TokenMetadata;
  receiver: Address;
  standardOrder: StandardOrder;
  quoteId: string;
  quoteType: string;
  quoteSpender?: Address;
  signature?: Hex;
}): OrderPreviewData {
  return {
    模式: args.actionLabel,
    QuoteId: args.quoteId,
    QuoteType: args.quoteType,
    來源鏈: args.sourceChainName,
    目的鏈: args.destinationChainName,
    來源Token: `${args.fromToken.symbol} (${args.fromToken.address})`,
    目的Token: `${args.toToken.symbol} (${args.toToken.address})`,
    輸入數量: formatAmountWithDecimals(
      computeTotalInputAmount(args.standardOrder),
      args.fromToken,
    ),
    Receiver: args.receiver,
    QuoteSpender: args.quoteSpender ?? null,
    使用者簽章: args.signature ? summarizeHex(args.signature) : null,
    StandardOrder: describeStandardOrder(args.standardOrder, {
      sourceToken: args.fromToken,
      destinationToken: args.toToken,
    }),
  };
}

function printOrderPreview(args: {
  actionLabel: "open" | "openFor";
  sourceChainName: string;
  destinationChainName: string;
  fromToken: TokenMetadata;
  toToken: TokenMetadata;
  receiver: Address;
  standardOrder: StandardOrder;
  quoteId: string;
  quoteType: string;
  quoteSpender?: Address;
  signature?: Hex;
}) {
  console.log(`${args.actionLabel} 訂單摘要:`);
  console.log(JSON.stringify(buildOrderPreviewData(args), null, 2));
}

export function buildDoctorReportData(args: {
  route: string;
  quoteId: string;
  quoteSpender: Address;
  configuredSettlerFallback: Address | null;
  totalInputAmount: bigint;
  previewOutputAmount: string;
  fromToken: TokenMetadata;
  toToken: TokenMetadata;
  orderPreview: OrderPreviewData;
  balance: bigint;
  allowances: Array<{
    label: string;
    address: Address;
    allowance: bigint;
    enough: boolean;
  }>;
  simulation: { ok: true } | { ok: false; error: string };
  trackingSummary: Record<string, unknown>;
}) {
  return {
    路由: args.route,
    QuoteId: args.quoteId,
    QuoteSpender: args.quoteSpender,
    預設InputSettler: args.configuredSettlerFallback,
    輸入數量Raw: args.totalInputAmount.toString(),
    輸入數量: formatAmountWithDecimals(args.totalInputAmount, args.fromToken),
    預估輸出數量Raw: args.previewOutputAmount,
    預估輸出數量:
      args.previewOutputAmount === "unknown"
        ? "unknown"
        : formatAmountWithDecimals(
            BigInt(args.previewOutputAmount),
            args.toToken,
          ),
    使用者餘額: {
      raw: args.balance.toString(),
      formatted: formatAmountWithDecimals(args.balance, args.fromToken),
      enough: args.balance >= args.totalInputAmount,
    },
    Allowances: args.allowances.map((item) => ({
      標的: item.label,
      地址: item.address,
      allowanceRaw: item.allowance.toString(),
      allowance: formatAmountWithDecimals(item.allowance, args.fromToken),
      enough: item.enough,
    })),
    open模擬: args.simulation,
    訂單摘要: args.orderPreview,
    多來源追蹤預覽: args.trackingSummary,
  };
}

async function ensureBalance(args: {
  publicClient: {
    readContract(args: unknown): Promise<unknown>;
  };
  tokenAddress: Address;
  owner: Address;
  requiredAmount: bigint;
  tokenLabel: string;
}) {
  const currentBalance = (await args.publicClient.readContract({
    address: args.tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [args.owner],
  })) as bigint;

  console.log(`${args.tokenLabel} balance: ${currentBalance.toString()}`);
  if (currentBalance < args.requiredAmount) {
    throw new Error(
      `${args.tokenLabel} 餘額不足，當前=${currentBalance}，所需至少=${args.requiredAmount}。`,
    );
  }
}

async function handleOpenFor(flags: Record<string, string | boolean>) {
  // 1. 解析命令列參數 (與 open 相同)
  const fromChainKey = parseChain(requiredFlag(flags, "from-chain"));
  const toChainKey = parseChain(requiredFlag(flags, "to-chain"));
  const fromTokenKey = parseToken(requiredFlag(flags, "from-token"));
  const toTokenKey = parseToken(requiredFlag(flags, "to-token"));
  const amount = requiredFlag(flags, "amount");
  const minOutput = stringFlag(flags, "min-output");
  const waitForOrder = Boolean(flags.wait);
  const autoApprove = Boolean(flags["auto-approve"]);
  const account = getUserAccount();

  if (fromChainKey === toChainKey) {
    throw new Error("此腳本目前只支援跨鏈交換，來源鏈與目標鏈不可相同。");
  }

  const fromChain = CHAIN_CONFIG[fromChainKey];
  const toChain = CHAIN_CONFIG[toChainKey];
  const receiver = resolveReceiver(
    stringFlag(flags, "receiver"),
    account.address,
  );
  const fromToken = await resolveTokenMetadata(fromChain.chainId, fromTokenKey);
  const toToken = await resolveTokenMetadata(toChain.chainId, toTokenKey);
  const requestBody = buildQuoteRequest({
    fromChainId: fromChain.chainId,
    toChainId: toChain.chainId,
    accountAddress: account.address,
    receiver,
    fromTokenAddress: fromToken.address,
    toTokenAddress: toToken.address,
    amount,
    minOutput,
  });
  const swapContext: SwapContext = {
    fromChainKey,
    toChainKey,
    fromTokenKey,
    toTokenKey,
    amount,
  };

  console.log("請求 quote 中...");
  console.log(
    JSON.stringify(
      {
        fromChain: fromChain.displayName,
        toChain: toChain.displayName,
        fromToken: `${fromTokenKey} (${fromToken.address})`,
        toToken: `${toTokenKey} (${toToken.address})`,
        amount,
        receiver,
      },
      null,
      2,
    ),
  );

  const quoteResponse = await requestQuoteWithGuidance(
    requestBody,
    swapContext,
  );

  const quote = pickEscrowQuote(quoteResponse.quotes);
  const standardOrder = buildStandardOrderFromEscrowQuote(quote.order);
  const totalInputAmount = computeTotalInputAmount(standardOrder);
  const outputPreview = quote.preview.outputs[0]?.amount ?? "unknown";
  const quoteSpender = addressValue(
    quote.order.payload.message.spender,
    "quote.order.payload.message.spender",
  );
  const publicClient = createPublicClient({
    chain: fromChain.viemChain,
    transport: http(fromChain.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: fromChain.viemChain,
    transport: http(fromChain.rpcUrl),
  });

  // 2. 檢查餘額
  await ensureBalance({
    publicClient,
    tokenAddress: fromToken.address,
    owner: account.address,
    requiredAmount: totalInputAmount,
    tokenLabel: `${fromChain.displayName} ${fromTokenKey}`,
  });

  // 3. 檢查並處理 Allowance (授權給 Permit2)
  // 注意：這裡是授權給 PERMIT2_ADDRESS，因為 openFor 是透過 Permit2 進行代扣
  await ensureAllowance({
    publicClient,
    walletClient,
    tokenAddress: fromToken.address,
    owner: account.address,
    spender: PERMIT2_ADDRESS,
    spenderLabel: "Permit2",
    requiredAmount: totalInputAmount,
    autoApprove,
    approveAmount: totalInputAmount,
    explorerBaseUrl: fromChain.explorerBaseUrl,
    insufficientHint: [
      `請先執行: npm run approve-permit2 -- --from-chain ${fromChainKey} --token ${fromTokenKey} --amount ${totalInputAmount}`,
      "或改用 openFor 指令加上 --auto-approve 讓指令先自動送出精準數量 approve。",
    ],
  });

  // 4. 產生 Permit2 簽章 (Off-chain)
  // 這裡並不會發送鏈上交易，而是使用 USER_PRIVATE_KEY 對訂單內容進行 EIP-712 簽章
  const signature = await signQuoteOrder(account, quote.order);

  printOrderPreview({
    actionLabel: "openFor",
    sourceChainName: fromChain.displayName,
    destinationChainName: toChain.displayName,
    fromToken,
    toToken,
    receiver,
    standardOrder,
    quoteId: quote.quoteId,
    quoteType: quote.order.type,
    quoteSpender,
    signature,
  });

  console.log(`選用 quoteId: ${quote.quoteId}`);
  console.log(`order type: ${quote.order.type}`);
  console.log(`預估輸出數量: ${outputPreview}`);
  if (quote.eta !== undefined) {
    console.log(`ETA: ${quote.eta} 秒`);
  }
  if (quote.validUntil !== undefined) {
    console.log(`validUntil: ${quote.validUntil}`);
  }

  // 5. 將 Quote ID 與 簽章 提交給 Solver API（計時器從此刻開始）
  // 這是 openFor 唯一與 Solver 互動的寫入動作
  const openForStartMs = Date.now();
  const orderResponse = await fetchJson<OrderApiResponse>(
    `${SOLVER_BASE_URL}/orders`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: quote.quoteId,
        signature,
      }),
    },
  );

  console.log(`送單狀態: ${orderResponse.status}`);
  if (orderResponse.orderId) {
    console.log(`orderId: ${orderResponse.orderId}`);
  }
  if (orderResponse.message) {
    console.log(`message: ${orderResponse.message}`);
  }

  // 6. 狀態確認機制：若有 --wait，以多來源並行追蹤至 finalize
  if (waitForOrder && orderResponse.orderId) {
    await waitForOrderCompletion(
      orderResponse.orderId,
      {
        orderId: orderResponse.orderId,
        sourceChainKey: fromChainKey,
        destinationChainKey: toChainKey,
        inputSettlerAddress:
          quoteSpender !== zeroAddress
            ? quoteSpender
            : resolveInputSettlerAddress(fromChain.chainId),
        outputSettlerAddress: OUTPUT_SETTLER_MAP[toChain.chainId],
        standardOrder,
      },
      openForStartMs,
    );
  }
}

async function handleOpen(flags: Record<string, string | boolean>) {
  // 1. 解析命令列參數 (來源鏈、目的鏈、代幣、數量等)
  const fromChainKey = parseChain(requiredFlag(flags, "from-chain"));
  const toChainKey = parseChain(requiredFlag(flags, "to-chain"));
  const fromTokenKey = parseToken(requiredFlag(flags, "from-token"));
  const toTokenKey = parseToken(requiredFlag(flags, "to-token"));
  const amount = requiredFlag(flags, "amount");
  const minOutput = stringFlag(flags, "min-output");
  const waitForSolver = Boolean(flags.wait); // 是否等待 solver 處理完成
  const autoApprove = Boolean(flags["auto-approve"]);
  const account = getUserAccount(); // 取得 USER_PRIVATE_KEY 對應的帳戶

  if (fromChainKey === toChainKey) {
    throw new Error("此腳本目前只支援跨鏈交換，來源鏈與目標鏈不可相同。");
  }

  // 2. 準備鏈與代幣的設定資料
  const fromChain = CHAIN_CONFIG[fromChainKey];
  const toChain = CHAIN_CONFIG[toChainKey];
  const receiver = resolveReceiver(
    stringFlag(flags, "receiver"),
    account.address,
  );
  const fromToken = await resolveTokenMetadata(fromChain.chainId, fromTokenKey);
  const toToken = await resolveTokenMetadata(toChain.chainId, toTokenKey);

  // 3. 建構向 Solver 請求報價 (Quote) 的 Payload
  const requestBody = buildQuoteRequest({
    fromChainId: fromChain.chainId,
    toChainId: toChain.chainId,
    accountAddress: account.address,
    receiver,
    fromTokenAddress: fromToken.address,
    toTokenAddress: toToken.address,
    amount,
    minOutput,
  });
  const swapContext: SwapContext = {
    fromChainKey,
    toChainKey,
    fromTokenKey,
    toTokenKey,
    amount,
  };

  console.log("請求 quote 中（供 open() 使用）...");
  console.log(
    JSON.stringify(
      {
        fromChain: fromChain.displayName,
        toChain: toChain.displayName,
        fromToken: `${fromTokenKey} (${fromToken.address})`,
        toToken: `${toTokenKey} (${toToken.address})`,
        amount,
        receiver,
        mode: "on-chain open() workaround",
      },
      null,
      2,
    ),
  );

  // 4. 向 Solver API 取得 Quote
  const quoteResponse = await requestQuoteWithGuidance(
    requestBody,
    swapContext,
  );
  const quote = pickEscrowQuote(quoteResponse.quotes);
  const standardOrder = buildStandardOrderFromEscrowQuote(quote.order);

  // 5. 安全性檢查：確保 Quote 的使用者與當前發送交易的帳戶一致
  if (standardOrder.user.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `quote 內的 order.user=${standardOrder.user} 與當前帳戶 ${account.address} 不符，無法直接呼叫 open()。`,
    );
  }

  // 6. 解析 InputSettler 合約地址
  const fallbackSettlerAddress = INPUT_SETTLER_MAP[fromChain.chainId];
  const quoteSpender = addressValue(
    quote.order.payload.message.spender,
    "quote.order.payload.message.spender",
  );
  const inputSettlerAddress = resolveOpenInputSettlerAddress(
    flags,
    fromChain.chainId,
    quoteSpender,
  );
  if (
    fallbackSettlerAddress &&
    quoteSpender.toLowerCase() !== fallbackSettlerAddress.toLowerCase()
  ) {
    console.warn(
      `警告: quote spender=${quoteSpender} 與 fallback settler=${fallbackSettlerAddress} 不一致。`,
    );
  }

  const totalInputAmount = computeTotalInputAmount(standardOrder);

  // 7. 初始化 Viem 的 PublicClient (讀取) 與 WalletClient (寫入)
  const publicClient = createPublicClient({
    chain: fromChain.viemChain,
    transport: http(fromChain.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: fromChain.viemChain,
    transport: http(fromChain.rpcUrl),
  });

  // 8. 檢查使用者的 Token 餘額是否足夠
  await ensureBalance({
    publicClient,
    tokenAddress: fromToken.address,
    owner: account.address,
    requiredAmount: totalInputAmount,
    tokenLabel: `${fromChain.displayName} ${fromTokenKey}`,
  });

  // 9. 檢查並處理 Allowance (授權給 InputSettler)
  // 這裡與 openFor 不同，open 是直接授權給 InputSettler 合約，而不是 Permit2
  await ensureAllowance({
    publicClient,
    walletClient,
    tokenAddress: fromToken.address,
    owner: account.address,
    spender: inputSettlerAddress,
    spenderLabel: "Input Settler",
    requiredAmount: totalInputAmount,
    autoApprove,
    approveAmount: totalInputAmount,
    explorerBaseUrl: fromChain.explorerBaseUrl,
    insufficientHint: [
      `請先執行: npm run approve-settler -- --from-chain ${fromChainKey} --token ${fromTokenKey} --amount ${totalInputAmount}`,
      "或改用 --auto-approve 讓 open 指令先自動送出 approve。",
    ],
  });

  // 10. 計算預期的鏈上 Order ID
  const orderId = (await publicClient.readContract({
    address: inputSettlerAddress,
    abi: INPUT_SETTLER_ABI,
    functionName: "orderIdentifier",
    args: [standardOrder],
  })) as Hex;

  printOrderPreview({
    actionLabel: "open",
    sourceChainName: fromChain.displayName,
    destinationChainName: toChain.displayName,
    fromToken,
    toToken,
    receiver,
    standardOrder,
    quoteId: quote.quoteId,
    quoteType: quote.order.type,
    quoteSpender,
  });

  console.log(`選用 quoteId: ${quote.quoteId}`);
  console.log(`on-chain orderId: ${orderId}`);
  console.log(`預估輸出數量: ${quote.preview.outputs[0]?.amount ?? "unknown"}`);
  if (quote.eta !== undefined) {
    console.log(`ETA: ${quote.eta} 秒`);
  }
  if (quote.validUntil !== undefined) {
    console.log(`validUntil: ${quote.validUntil}`);
  }

  // 11. 正式發送鏈上 open() 交易（計時器從此刻開始）
  const openStartMs = Date.now();
  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      address: inputSettlerAddress,
      abi: INPUT_SETTLER_ABI,
      functionName: "open",
      args: [standardOrder],
    });
  } catch (error) {
    throw error;
  }

  console.log(`open() tx: ${txHash}`);
  console.log(`Explorer: ${fromChain.explorerBaseUrl}/tx/${txHash}`);

  // 12. 等待交易上鏈確認
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  if (receipt.status !== "success") {
    throw new Error("open() 交易失敗。");
  }
  console.log(`open() 已確認，block=${receipt.blockNumber}`);

  // 13. 將訂單資訊存入本地快取 (供日後 refund 使用)
  const orderFile = await saveOpenOrderRecord({
    version: 1,
    savedAt: new Date().toISOString(),
    orderId,
    quoteId: quote.quoteId,
    openTxHash: txHash,
    fromChainKey,
    toChainKey,
    fromTokenKey,
    toTokenKey,
    fromTokenAddress: fromToken.address,
    toTokenAddress: toToken.address,
    inputSettlerAddress,
    quoteSpender,
    standardOrder,
  });
  console.log(`order file: ${orderFile}`);

  // 14. 狀態確認機制：若有 --wait，以多來源並行追蹤至 finalize
  if (waitForSolver) {
    await waitForOnchainOrderCompletion(
      orderId,
      {
        orderId,
        sourceChainKey: fromChainKey,
        destinationChainKey: toChainKey,
        inputSettlerAddress,
        outputSettlerAddress: OUTPUT_SETTLER_MAP[toChain.chainId],
        standardOrder,
        openTxHash: txHash,
      },
      openStartMs,
    );
  }
}

async function handleStatus(flags: Record<string, string | boolean>) {
  const orderId = requiredFlag(flags, "order-id");
  const order = await fetchSolverOrder(orderId);
  printOrderStatusSummary(orderId, order);
}

function getUserAccount() {
  const privateKey = process.env.USER_PRIVATE_KEY as Hex | undefined;
  if (!privateKey) {
    throw new Error(
      "Missing USER_PRIVATE_KEY. Set it in packages/my-oif-solver/.env (see .env.example).",
    );
  }
  return privateKeyToAccount(privateKey);
}

function resolveReceiver(
  receiver: string | undefined,
  defaultAddress: Address,
): Address {
  if (!receiver) {
    return defaultAddress;
  }
  if (!isAddress(receiver)) {
    throw new Error(`receiver 不是合法地址: ${receiver}`);
  }
  return receiver;
}

/** 計算下一輪輪詢間隔：指數退避（×1.5），上限為 MAX_POLL_INTERVAL_MS */
function nextPollInterval(current: number): number {
  return Math.min(Math.round(current * 1.5), MAX_POLL_INTERVAL_MS);
}

/**
 * 從 snapshot 的任何已知欄位萃取 fillTxHash，
 * 避免對 Record<string,unknown> 做複雜型別斷言。
 */
function extractFillTxHash(snapshot: Record<string, unknown>): Hex | undefined {
  const solver = snapshot["solver"] as Record<string, unknown> | undefined;
  const solverHash = (
    solver?.["fill交易"] as Record<string, unknown> | undefined
  )?.["hash"];
  if (typeof solverHash === "string" && solverHash.startsWith("0x"))
    return solverHash as Hex;

  const dest = snapshot["目的鏈"] as Record<string, unknown> | undefined;
  const ofEntry = dest?.["OutputFilled事件"] as
    | Record<string, unknown>
    | null
    | undefined;
  const ofHash = ofEntry?.["transactionHash"];
  if (typeof ofHash === "string" && ofHash.startsWith("0x"))
    return ofHash as Hex;

  return undefined;
}

async function waitForOrderCompletion(
  orderId: string,
  trackingContext?: OrderTrackingContext,
  startMs?: number,
) {
  const timerStart = startMs ?? Date.now();
  console.log("\n  開始以多來源並行追蹤訂單完整流程...");
  const deadline = Date.now() + ORDER_TIMEOUT_MS;
  let lastSnapshotJson = "";
  let pollInterval = BASE_POLL_INTERVAL_MS;

  // --- Per-session caches (items B & C) ---
  let cachedFillTxHash: Hex | undefined;
  let cachedOutputFilledResult:
    | SettledResult<OutputFilledCacheEntry>
    | undefined;

  // Item A: estimate destination chain start block from open tx timestamp (once).
  let outputFilledFromBlock: bigint | undefined;
  if (trackingContext?.openTxHash) {
    try {
      outputFilledFromBlock =
        await estimateDestChainStartBlock(trackingContext);
      if (outputFilledFromBlock !== undefined) {
        console.log(
          `  OutputFilled 掃描起始區塊（目的鏈估算）: ${outputFilledFromBlock}`,
        );
      }
    } catch {
      // Non-fatal; fall back to env-variable lookback range
    }
  }

  while (Date.now() < deadline) {
    if (trackingContext) {
      const snapshot = await buildTrackingSnapshot(trackingContext, {
        knownFillTxHash: cachedFillTxHash,
        knownOutputFilledResult: cachedOutputFilledResult,
        outputFilledFromBlock,
      });

      // Cache fillTxHash as soon as it appears (item C)
      if (!cachedFillTxHash) {
        const found = extractFillTxHash(snapshot as Record<string, unknown>);
        if (found) {
          cachedFillTxHash = found;
          // Also cache the OutputFilled display entry to reuse in later rounds
          const dest = (snapshot as Record<string, unknown>)["目的鏈"] as
            | Record<string, unknown>
            | undefined;
          const ofEntry = dest?.["OutputFilled事件"] as
            | Record<string, unknown>
            | null
            | undefined;
          if (ofEntry && "transactionHash" in ofEntry) {
            cachedOutputFilledResult = {
              ok: true as const,
              value: {
                blockNumber:
                  typeof ofEntry["blockNumber"] === "string"
                    ? ofEntry["blockNumber"]
                    : null,
                transactionHash:
                  typeof ofEntry["transactionHash"] === "string"
                    ? (ofEntry["transactionHash"] as Hex)
                    : null,
              },
            };
          }
        }
      }

      const snapshotJson = JSON.stringify(snapshot);
      if (snapshotJson !== lastSnapshotJson) {
        printTrackingSnapshotSections(snapshot as Record<string, unknown>);
        // Phase changed: reset backoff so next transition is caught quickly
        pollInterval = BASE_POLL_INTERVAL_MS;
        lastSnapshotJson = snapshotJson;
      }

      const { terminated, confirmedBy, isFailed } = checkTermination(
        snapshot as Record<string, unknown>,
      );
      if (terminated) {
        const elapsed = Date.now() - timerStart;
        console.log(`\n${"═".repeat(54)}`);
        if (isFailed) {
          console.log("  [✗] 訂單流程已失敗！");
        } else {
          console.log("  [✓] 訂單流程已全部確認完成！");
        }
        console.log(`  確認來源: ${confirmedBy.join(" | ")}`);
        console.log(`  ⏱  開單至結算總耗時: ${formatDuration(elapsed)}`);
        console.log("═".repeat(54));
        return;
      }
    } else {
      // No tracking context: simple solver API polling (fallback)
      try {
        const order = await fetchSolverOrder(orderId);
        const statusText = formatOrderStatus(order.status);
        if (statusText !== lastSnapshotJson) {
          printOrderStatusSummary(orderId, order);
          pollInterval = BASE_POLL_INTERVAL_MS;
          lastSnapshotJson = statusText;
        }
        if (isTerminalStatus(order.status)) {
          if (startMs !== undefined) {
            const elapsed = Date.now() - timerStart;
            console.log(`  ⏱  總耗時: ${formatDuration(elapsed)}`);
          }
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('"error": "ORDER_NOT_FOUND"')) {
          console.log("  訂單已送出，但 solver 尚未完成索引，等待後重試...");
          await sleep(pollInterval);
          pollInterval = nextPollInterval(pollInterval);
          continue;
        }
        throw error;
      }
    }
    await sleep(pollInterval);
    pollInterval = nextPollInterval(pollInterval);
  }

  throw new Error(
    `輪詢逾時 (${Math.floor(ORDER_TIMEOUT_MS / 60000)} 分鐘)，請手動查詢訂單狀態: ${orderId}`,
  );
}

function isTerminalStatus(status: string | { failed: [string, string] }) {
  if (typeof status !== "string") {
    return true;
  }

  return status === "finalized";
}

function printStatusIfChanged(
  orderId: string,
  order: SolverOrderRecord,
  lastStatus: string,
) {
  const statusText = formatOrderStatus(order.status);
  if (statusText !== lastStatus) {
    printOrderStatusSummary(orderId, order);
    return statusText;
  }
  return lastStatus;
}

function printOrderStatusSummary(orderId: string, order: SolverOrderRecord) {
  console.log(`orderId: ${orderId}`);
  console.log(`訂單狀態: ${formatOrderStatus(order.status)}`);
  if (order.fillTransaction?.hash) {
    console.log(
      `fill tx: ${order.fillTransaction.hash} (${order.fillTransaction.status})`,
    );
  }
}

function formatOrderStatus(status: string | { failed: [string, string] }) {
  return typeof status === "string"
    ? status
    : `failed:${status.failed[0]}:${status.failed[1]}`;
}

async function waitForOnchainOrderCompletion(
  orderId: Hex,
  trackingContext?: OrderTrackingContext,
  startMs?: number,
) {
  console.log(
    "  on-chain 開單模式：Solver 可能尚未索引，將以鏈上狀態為主要確認來源。",
  );
  // Delegate to unified multi-source tracking loop.
  // buildTrackingSnapshot internally tries both 0x-prefixed and plain orderId
  // when the solver returns ORDER_NOT_FOUND.
  await waitForOrderCompletion(orderId, trackingContext, startMs);
}

function printTrackingSnapshotSections(snapshot: Record<string, unknown>) {
  const phase = detectPhase(snapshot);
  const allPhases: OrderPhase[] = ["open", "fill", "submit", "finalize"];

  // Detect whether the order is in a failure state (solver API returned failed:*)
  const isFailed = (() => {
    const sol = snapshot["solver"] as Record<string, unknown> | undefined;
    if (sol && "訂單狀態" in sol) {
      return String(sol["訂單狀態"]).startsWith("failed:");
    }
    return false;
  })();

  const icon = (p: OrderPhase): string => {
    const ci = allPhases.indexOf(phase);
    const pi = allPhases.indexOf(p);
    if (pi < ci) return "[✓]";
    if (pi === ci) return isFailed ? "[✗]" : "[~]";
    return "[ ]";
  };

  const note = (p: OrderPhase): string => {
    const ci = allPhases.indexOf(phase);
    const pi = allPhases.indexOf(p);
    if (pi < ci) return "已確認";
    if (pi === ci) {
      if (isFailed) return "失敗";
      const m: Record<OrderPhase, string> = {
        open: "等待訂單送出確認...",
        fill: "等待 Solver 目的鏈成交...",
        submit: "等待 Hyperlane 跨鏈訊息投遞...",
        finalize: "等待來源鏈結算確認...",
      };
      return m[p];
    }
    const n: Record<OrderPhase, string> = {
      open: "",
      fill: "(等待開單後啟動)",
      submit: "(等待 Fill 完成後啟動)",
      finalize: "(等待跨鏈訊息後啟動)",
    };
    return n[p];
  };

  const bar = "═".repeat(54);
  const sep = "─".repeat(54);
  const orderId = snapshot["訂單識別"];
  const shortId = orderId
    ? (() => {
        const s = String(orderId);
        return s.length > 24 ? `${s.slice(0, 10)}...${s.slice(-10)}` : s;
      })()
    : "";

  console.log(`\n${bar}`);
  if (shortId) console.log(`  訂單監控  ${shortId}`);
  console.log(bar);
  console.log(`  ${icon("open")}   ① OPEN / openFor     ${note("open")}`);
  console.log(`  ${icon("fill")}   ② FILL               ${note("fill")}`);
  console.log(`  ${icon("submit")} ③ SUBMIT (Hyperlane)  ${note("submit")}`);
  console.log(`  ${icon("finalize")} ④ FINALIZE           ${note("finalize")}`);
  console.log(sep);

  // Determine if ALL active data sources have errors (for error suppression logic)
  const keys = ["solver", "來源鏈", "目的鏈", "Hyperlane"];
  const available = keys.filter(
    (k) => snapshot[k] !== null && snapshot[k] !== undefined,
  );
  const errored = available.filter((k) => {
    const d = snapshot[k];
    return (
      typeof d === "object" &&
      d !== null &&
      "錯誤" in (d as Record<string, unknown>)
    );
  });
  const allFailed = errored.length > 0 && errored.length === available.length;

  // ── Solver API ──
  {
    const d = snapshot["solver"] as Record<string, unknown> | undefined;
    if (d) {
      const isErr = "錯誤" in d;
      if (isErr && !allFailed) {
        console.log("\n  [ Solver API ] (暫時無法取得)");
      } else {
        console.log("\n  [ Solver API ]");
        if (isErr) {
          console.log(`    錯誤: ${d["錯誤"]}`);
        } else {
          console.log(`    訂單狀態: ${d["訂單狀態"]}`);
          const ft = d["fill交易"] as
            | Record<string, unknown>
            | null
            | undefined;
          if (ft && "hash" in ft) {
            console.log(`    Fill 交易: ${ft["hash"]}`);
          }
        }
      }
    }
  }

  // ── 來源鏈 InputSettler ──
  {
    const d = snapshot["來源鏈"] as Record<string, unknown> | undefined;
    if (d) {
      const isErr = "錯誤" in d;
      console.log(`\n  [ ① 來源鏈 ] ${d["鏈名稱"] ?? ""}`);
      if (isErr && !allFailed) {
        console.log("    (暫時無法取得)");
      } else if (isErr) {
        console.log(`    錯誤: ${d["錯誤"]}`);
      } else {
        const escrow = d["escrow狀態"] as Record<string, unknown> | undefined;
        if (escrow && "label" in escrow) {
          console.log(`    InputSettler 狀態: ${escrow["label"]}`);
        }
        const fin = d["Finalised事件"] as
          | Record<string, unknown>
          | null
          | undefined;
        if (fin == null) {
          // not yet available
        } else if ("transactionHash" in fin) {
          if (fin["transactionHash"]) {
            console.log(
              `    Finalised 事件: block ${fin["blockNumber"]}, tx ${String(fin["transactionHash"]).slice(0, 18)}...`,
            );
          } else {
            console.log("    Finalised 事件: 尚未發現");
          }
        } else if ("狀態" in fin) {
          console.log(`    Finalised 掃描: ${fin["狀態"]}`);
        }
      }
    }
  }

  // ── 目的鏈 OutputSettler ──
  {
    const d = snapshot["目的鏈"] as Record<string, unknown> | undefined;
    if (d) {
      console.log(`\n  [ ② 目的鏈 ] ${d["鏈名稱"] ?? ""}`);
      // OutputFilled event (orderId-indexed scan — primary on-chain fallback)
      const of_ = d["OutputFilled事件"];
      if (of_ !== undefined) {
        if (of_ == null) {
          console.log("    OutputFilled 事件: 尚未偵測到");
        } else if (
          typeof of_ === "object" &&
          "transactionHash" in (of_ as Record<string, unknown>)
        ) {
          const o = of_ as Record<string, unknown>;
          if (o["transactionHash"]) {
            console.log(
              `    OutputFilled 事件: block ${o["blockNumber"]}, tx ${String(o["transactionHash"]).slice(0, 18)}...`,
            );
          } else {
            console.log("    OutputFilled 事件: 尚未偵測到");
          }
        } else if (
          typeof of_ === "object" &&
          "錯誤" in (of_ as Record<string, unknown>) &&
          allFailed
        ) {
          console.log(
            `    OutputFilled 掃描錯誤: ${(of_ as Record<string, unknown>)["錯誤"]}`,
          );
        }
      }
      // Fill receipt (from solver fill tx hash)
      const fr = d["fillReceipt"] as Record<string, unknown> | null | undefined;
      if (fr && "status" in fr) {
        console.log(
          `    Fill 收據: ${fr["status"]} (block ${fr["blockNumber"] ?? "?"})`,
        );
      }
    }
  }

  // ── Hyperlane 跨鏈訊息 ──
  {
    const d = snapshot["Hyperlane"];
    if (d !== null && d !== undefined) {
      const hd = d as Record<string, unknown>;
      const isErr = "錯誤" in hd;
      if (isErr && !allFailed) {
        // suppress individual Hyperlane error when other sources work
      } else {
        console.log("\n  [ ③ Hyperlane 跨鏈訊息 ]");
        if (isErr) {
          console.log(`    錯誤: ${hd["錯誤"]}`);
        } else if ("messageId" in hd) {
          const mid = String(hd["messageId"]);
          console.log(`    訊息 ID: ${mid.slice(0, 18)}...`);
          const mv = hd["messageView"] as
            | Record<string, unknown>
            | null
            | undefined;
          if (mv && "is_delivered" in mv) {
            console.log(`    已投遞: ${mv["is_delivered"]}`);
            if (mv["delivery_occurred_at"]) {
              console.log(`    投遞時間: ${mv["delivery_occurred_at"]}`);
            }
          }
        } else if ("狀態" in hd) {
          console.log(`    ${hd["狀態"]}`);
        }
      }
    }
  }

  console.log(`\n${bar}`);
}

async function printTrackingSnapshotIfChanged(
  context: OrderTrackingContext,
  previous: string,
) {
  const snapshot = await buildTrackingSnapshot(context);
  const serialized = JSON.stringify(snapshot);
  if (serialized !== previous) {
    printTrackingSnapshotSections(snapshot as Record<string, unknown>);
    return serialized;
  }
  return previous;
}

function normalizeFinalisedProbeFailure(
  error: string,
): Record<string, unknown> {
  if (error.includes("exceed maximum block range")) {
    return {
      狀態: "RPC 掃描範圍受限",
      說明: "公開 RPC 常限制單次 eth_getLogs 的區塊跨度；這不代表 Finalised 失敗或訂單失敗。腳本已改為分段掃描並以 open 交易區塊為起點；若仍見此訊息，請在 .env 改用較寬鬆的 SEPOLIA_RPC_URL / BASE_SEPOLIA_RPC_URL（例如 Alchemy）。",
      詳情: error,
    };
  }
  return { 錯誤: error };
}

export function buildTrackingSummaryData(args: {
  orderId: string;
  sourceChainName: string;
  destinationChainName: string;
  solverOrderResult:
    | SettledResult<SolverOrderRecord>
    | { ok: false; error: string };
  sourceOrderStatusResult:
    | SettledResult<{ code: number; label: string }>
    | { ok: false; error: string };
  finalisedLogResult:
    | SettledResult<{
        blockNumber: string | null;
        transactionHash: Hex | null;
      } | null>
    | { ok: false; error: string };
  fillReceiptResult?:
    | SettledResult<{ status: string; blockNumber?: bigint | null }>
    | undefined;
  outputSettlerLogsResult?:
    | SettledResult<{
        blockNumber: string;
        logCount: number;
        topics: Array<Hex | null>;
      }>
    | undefined;
  outputFilledResult?:
    | SettledResult<{
        blockNumber: string | null;
        transactionHash: Hex | null;
      } | null>
    | undefined;
  mailboxDispatchResult?: SettledResult<Hex | null> | undefined;
  hyperlaneResult?: SettledResult<Record<string, unknown> | null> | undefined;
}) {
  const fillReceipt = args.fillReceiptResult?.ok
    ? args.fillReceiptResult.value
    : undefined;
  const fillReceiptError =
    args.fillReceiptResult && !args.fillReceiptResult.ok
      ? args.fillReceiptResult.error
      : undefined;
  const outputSettlerLogsError =
    args.outputSettlerLogsResult && !args.outputSettlerLogsResult.ok
      ? args.outputSettlerLogsResult.error
      : undefined;

  return {
    訂單識別: args.orderId,
    來源鏈: {
      鏈名稱: args.sourceChainName,
      escrow狀態: args.sourceOrderStatusResult.ok
        ? args.sourceOrderStatusResult.value
        : { 錯誤: args.sourceOrderStatusResult.error },
      Finalised事件: args.finalisedLogResult.ok
        ? args.finalisedLogResult.value
        : normalizeFinalisedProbeFailure(args.finalisedLogResult.error),
    },
    solver: args.solverOrderResult.ok
      ? {
          訂單狀態: formatOrderStatus(args.solverOrderResult.value.status),
          fill交易: args.solverOrderResult.value.fillTransaction?.hash
            ? {
                hash: args.solverOrderResult.value.fillTransaction.hash,
                status: args.solverOrderResult.value.fillTransaction.status,
                timestamp:
                  args.solverOrderResult.value.fillTransaction.timestamp,
              }
            : null,
        }
      : { 錯誤: args.solverOrderResult.error },
    目的鏈: {
      鏈名稱: args.destinationChainName,
      fillReceipt: fillReceipt
        ? {
            status: fillReceipt.status,
            blockNumber: fillReceipt.blockNumber?.toString(),
          }
        : args.fillReceiptResult
          ? { 錯誤: fillReceiptError ?? "未知錯誤" }
          : null,
      OutputSettler掃描: args.outputSettlerLogsResult?.ok
        ? args.outputSettlerLogsResult.value
        : args.outputSettlerLogsResult
          ? { 錯誤: outputSettlerLogsError ?? "未知錯誤" }
          : null,
      OutputFilled事件:
        args.outputFilledResult === undefined
          ? undefined
          : args.outputFilledResult.ok
            ? args.outputFilledResult.value
            : { 錯誤: args.outputFilledResult.error },
    },
    Hyperlane: (() => {
      if (!args.mailboxDispatchResult) {
        return null;
      }
      if (args.mailboxDispatchResult.ok) {
        const id = args.mailboxDispatchResult.value;
        if (id) {
          return {
            messageId: id,
            messageView: args.hyperlaneResult?.ok
              ? args.hyperlaneResult.value
              : args.hyperlaneResult && !args.hyperlaneResult.ok
                ? args.hyperlaneResult.error
                : null,
          };
        }
        return {
          狀態: "無 DispatchId",
          說明: "在 fill 交易所在區塊內未掃到 Mailbox 的 DispatchId；不代表訂單失敗，可能只是此路徑未經該 Mailbox 或事件不在同一區塊。",
        };
      }
      return { 錯誤: args.mailboxDispatchResult.error };
    })(),
  };
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小時 ${m} 分 ${s} 秒`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function detectPhase(snapshot: Record<string, unknown>): OrderPhase {
  const src = snapshot["來源鏈"] as Record<string, unknown> | undefined;
  const finalised = src?.["Finalised事件"] as
    | Record<string, unknown>
    | null
    | undefined;
  if (
    finalised &&
    "transactionHash" in finalised &&
    finalised["transactionHash"]
  ) {
    return "finalize";
  }
  const escrow = src?.["escrow狀態"] as Record<string, unknown> | undefined;
  if (escrow && "code" in escrow) {
    const c = Number(escrow["code"]);
    if (c === 2 || c === 3) return "finalize";
  }
  const solver = snapshot["solver"] as Record<string, unknown> | undefined;
  if (solver && "訂單狀態" in solver) {
    const st = String(solver["訂單狀態"]);
    if (st === "finalized") return "finalize";
    if (st.startsWith("failed:")) {
      // Parse the phase name from "failed:{Phase}:{message}" to show the
      // failure icon on the correct phase row rather than on "finalize".
      const phasePart = st.split(":")[1]?.toLowerCase() ?? "";
      if (phasePart === "fill") return "fill";
      if (phasePart === "submit") return "submit";
      if (phasePart === "finalize") return "finalize";
      return "finalize"; // unknown phase → default to finalize
    }
  }
  const hyper = snapshot["Hyperlane"] as
    | Record<string, unknown>
    | null
    | undefined;
  if (hyper && "messageId" in hyper) return "submit";
  const dest = snapshot["目的鏈"] as Record<string, unknown> | undefined;
  if (dest) {
    const fillReceipt = dest["fillReceipt"] as
      | Record<string, unknown>
      | null
      | undefined;
    if (fillReceipt && "status" in fillReceipt) return "fill";
    const outputFilled = dest["OutputFilled事件"] as
      | Record<string, unknown>
      | null
      | undefined;
    if (
      outputFilled &&
      "transactionHash" in outputFilled &&
      outputFilled["transactionHash"]
    )
      return "fill";
    const outputSettler = dest["OutputSettler掃描"] as
      | Record<string, unknown>
      | null
      | undefined;
    if (
      outputSettler &&
      "logCount" in outputSettler &&
      Number(outputSettler["logCount"]) > 0
    )
      return "fill";
  }
  if (solver && "fill交易" in solver) {
    const ft = solver["fill交易"] as Record<string, unknown> | null | undefined;
    if (ft && "hash" in ft) return "fill";
  }
  return "open";
}

function checkTermination(snapshot: Record<string, unknown>): {
  terminated: boolean;
  confirmedBy: string[];
  isFailed: boolean;
} {
  const confirmedBy: string[] = [];
  let isFailed = false;
  const solver = snapshot["solver"] as Record<string, unknown> | undefined;
  if (solver && "訂單狀態" in solver) {
    const st = String(solver["訂單狀態"]);
    if (st === "finalized") {
      confirmedBy.push("Solver API (finalized)");
    } else if (st.startsWith("failed:")) {
      confirmedBy.push(`Solver API (${st})`);
      isFailed = true;
    }
  }
  const src = snapshot["來源鏈"] as Record<string, unknown> | undefined;
  const escrow = src?.["escrow狀態"] as Record<string, unknown> | undefined;
  if (escrow && "code" in escrow) {
    const c = Number(escrow["code"]);
    if (c === 2) confirmedBy.push("InputSettler 鏈上: Claimed");
    else if (c === 3) confirmedBy.push("InputSettler 鏈上: Refunded");
  }
  const finalised = src?.["Finalised事件"] as
    | Record<string, unknown>
    | null
    | undefined;
  if (
    finalised &&
    "transactionHash" in finalised &&
    finalised["transactionHash"]
  ) {
    confirmedBy.push(`Finalised 事件 (block ${finalised["blockNumber"]})`);
  }
  return { terminated: confirmedBy.length > 0, confirmedBy, isFailed };
}

type OutputFilledCacheEntry = {
  blockNumber: string | null;
  transactionHash: Hex | null;
} | null;

type TrackingSnapshotOpts = {
  /**
   * 若 fillTxHash 已在前一輪確認，跳過 OutputFilled 掃描（加快後期輪詢）。
   * 優先於任何掃描結果作為 Phase 2 的起點。
   */
  knownFillTxHash?: Hex;
  /**
   * 已快取的 OutputFilled 事件結果（避免重複掃描，用於顯示）。
   * 只在 knownFillTxHash 已知時使用。
   */
  knownOutputFilledResult?: SettledResult<OutputFilledCacheEntry>;
  /**
   * OutputFilled 掃描的起始區塊提示（由 open tx 時間戳估算）。
   * 若未提供則退回預設回溯範圍。
   */
  outputFilledFromBlock?: bigint;
};

/**
 * 利用 open tx 的區塊時間戳，估算目的鏈上對應的區塊號碼，
 * 作為 OutputFilled 掃描的起點，避免掃描過多無關歷史區塊。
 */
async function estimateDestChainStartBlock(
  context: OrderTrackingContext,
): Promise<bigint | undefined> {
  if (!context.openTxHash) return undefined;
  const sourceChain = CHAIN_CONFIG[context.sourceChainKey];
  const destChain = CHAIN_CONFIG[context.destinationChainKey];
  const sourceClient = createPublicClient({
    chain: sourceChain.viemChain,
    transport: http(sourceChain.rpcUrl),
  });
  const destClient = createPublicClient({
    chain: destChain.viemChain,
    transport: http(destChain.rpcUrl),
  });
  try {
    // Parallel: source receipt + dest latest block
    const [sourceReceipt, destLatest] = await Promise.all([
      sourceClient.getTransactionReceipt({ hash: context.openTxHash }),
      destClient.getBlock({ blockTag: "latest" }),
    ]);
    // Parallel: source open block timestamp + dest sample block for avg block time
    const sampleSize = 200n;
    const [sourceOpenBlock, destSampleBlock] = await Promise.all([
      sourceClient.getBlock({ blockNumber: sourceReceipt.blockNumber }),
      destClient.getBlock({
        blockNumber:
          destLatest.number > sampleSize ? destLatest.number - sampleSize : 0n,
      }),
    ]);
    const openTimestamp = Number(sourceOpenBlock.timestamp);
    const latestDestTimestamp = Number(destLatest.timestamp);
    const latestDestNumber = destLatest.number;
    if (openTimestamp >= latestDestTimestamp) return latestDestNumber;

    // Average block time (seconds/block) on destination chain
    const sampledBlocks = Number(latestDestNumber - destSampleBlock.number);
    if (sampledBlocks <= 0) return undefined;
    const avgBlockTime =
      (latestDestTimestamp - Number(destSampleBlock.timestamp)) / sampledBlocks;
    if (avgBlockTime <= 0) return undefined;

    // Estimated blocks to go back, with a 200-block safety buffer
    const secondsAgo = latestDestTimestamp - openTimestamp;
    const blocksBack = BigInt(Math.ceil(secondsAgo / avgBlockTime) + 200);
    return latestDestNumber > blocksBack ? latestDestNumber - blocksBack : 0n;
  } catch {
    return undefined;
  }
}

async function buildTrackingSnapshot(
  context: OrderTrackingContext,
  opts?: TrackingSnapshotOpts,
) {
  const sourceChain = CHAIN_CONFIG[context.sourceChainKey];
  const destinationChain = CHAIN_CONFIG[context.destinationChainKey];
  const sourceClient = createPublicClient({
    chain: sourceChain.viemChain,
    transport: http(sourceChain.rpcUrl),
  });
  const destinationClient = createPublicClient({
    chain: destinationChain.viemChain,
    transport: http(destinationChain.rpcUrl),
  });
  const normalizedOrderId = normalizeOrderIdHex(context.orderId);
  const noId = { ok: false as const, error: "orderId 不是 bytes32" };

  // Phase 1: All independent queries run in parallel.
  // If knownFillTxHash is already cached, skip the expensive OutputFilled scan (item C).
  const [solverOrderResult, sourceOrderStatusResult, finalisedLogResult] =
    await Promise.all([
      // Solver HTTP API — also tries without 0x prefix for on-chain open mode
      settledValue(async () => {
        try {
          return await fetchSolverOrder(context.orderId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (
            msg.includes('"error": "ORDER_NOT_FOUND"') &&
            context.orderId.startsWith("0x")
          ) {
            return await fetchSolverOrder(context.orderId.slice(2));
          }
          throw e;
        }
      }),
      // Source chain: InputSettler orderStatus
      normalizedOrderId
        ? settledValue(() =>
            fetchOnchainOrderStatus(
              sourceClient,
              context.inputSettlerAddress,
              normalizedOrderId,
            ),
          )
        : Promise.resolve({
            ...noId,
            error: "orderId 不是 bytes32，無法查鏈上 orderStatus",
          }),
      // Source chain: Finalised event scan (no anchor block needed for testnets)
      normalizedOrderId
        ? settledValue(() =>
            findFinalisedLog(
              sourceClient,
              context.inputSettlerAddress,
              normalizedOrderId,
            ),
          )
        : Promise.resolve({
            ...noId,
            error: "orderId 不是 bytes32，無法掃 Finalised 事件",
          }),
    ]);

  // Destination chain: OutputFilled event scan — skipped when fillTxHash already known.
  let outputFilledResult: SettledResult<OutputFilledCacheEntry>;
  if (opts?.knownFillTxHash) {
    // Re-use the cached result from a previous iteration; no need to re-scan.
    outputFilledResult = opts.knownOutputFilledResult ?? {
      ok: true as const,
      value: null,
    };
  } else if (normalizedOrderId) {
    outputFilledResult = await settledValue(() =>
      findOutputSettlerFillLog(
        destinationClient,
        context.outputSettlerAddress,
        normalizedOrderId,
        opts?.outputFilledFromBlock,
      ),
    );
  } else {
    outputFilledResult = {
      ...noId,
      error: "orderId 不是 bytes32，無法掃 OutputFilled 事件",
    };
  }

  // Determine fill tx hash: opts cache (fastest) → Solver API → OutputFilled event
  const fillTxHashFromSolver =
    solverOrderResult.ok && solverOrderResult.value.fillTransaction?.hash
      ? (solverOrderResult.value.fillTransaction.hash as Hex)
      : undefined;
  const fillTxHashFromEvent =
    outputFilledResult.ok && outputFilledResult.value?.transactionHash
      ? outputFilledResult.value.transactionHash
      : undefined;
  const fillTxHash =
    opts?.knownFillTxHash ?? fillTxHashFromSolver ?? fillTxHashFromEvent;

  // Phase 2: Fill-tx-dependent queries run in parallel
  let fillReceiptResult:
    | SettledResult<
        Awaited<ReturnType<typeof destinationClient.getTransactionReceipt>>
      >
    | undefined;
  let outputSettlerLogsResult:
    | SettledResult<Awaited<ReturnType<typeof findOutputSettlerLogs>>>
    | undefined;
  let mailboxDispatchResult: SettledResult<Hex | null> | undefined;
  let hyperlaneResult:
    | SettledResult<Awaited<ReturnType<typeof fetchHyperlaneMessageView>>>
    | undefined;

  if (fillTxHash) {
    // Phase 2a: Get fill receipt + output settler logs in parallel
    const [fillReceiptRaw, outputSettlerLogsRaw] = await Promise.all([
      settledValue(() =>
        destinationClient.getTransactionReceipt({ hash: fillTxHash }),
      ),
      settledValue(() =>
        findOutputSettlerLogs(
          destinationClient,
          context.outputSettlerAddress,
          fillTxHash,
        ),
      ),
    ]);
    fillReceiptResult = fillReceiptRaw;
    outputSettlerLogsResult = outputSettlerLogsRaw;

    // Extract OutputFilled from receipt logs — more reliable than a getLogs scan.
    // OutputSettlerSimple.fill() always emits OutputFilled if the tx succeeded.
    if (fillReceiptRaw.ok && fillReceiptRaw.value && normalizedOrderId) {
      const fromReceipt = extractOutputFilledFromReceipt(
        fillReceiptRaw.value.logs as readonly {
          address: Address;
          topics: readonly Hex[];
          transactionHash: Hex | null;
          blockNumber: bigint | null;
        }[],
        context.outputSettlerAddress,
        normalizedOrderId,
      );
      if (fromReceipt !== null) {
        // Override Phase 1 scan result with the authoritative receipt-based value.
        outputFilledResult = { ok: true as const, value: fromReceipt };
      }
    }

    // Phase 2b: Scan Hyperlane Mailbox for Dispatch event from the output oracle.
    // The PostFill tx (separate from the fill tx) is what emits DispatchId.
    // We filter by sender = output oracle and scan AFTER the fill block.
    const fillBlock = fillReceiptRaw.ok
      ? fillReceiptRaw.value?.blockNumber
      : undefined;
    const destChainId = destinationChain.chainId;
    const outputOracleAddress = OUTPUT_ORACLE_MAP[destChainId];
    const mailboxAddress = HYPERLANE_MAILBOX_MAP[destChainId];

    if (fillBlock && mailboxAddress) {
      // outputOracleAddress may be undefined (unknown chain); pass 1 will be skipped,
      // pass 2 (DispatchId fallback) will still run.
      mailboxDispatchResult = await settledValue(() =>
        findMailboxDispatchIdAfterFill(
          destinationClient,
          mailboxAddress,
          outputOracleAddress, // possibly undefined → skips pass 1
          fillBlock,
        ),
      );
    } else {
      mailboxDispatchResult = { ok: true as const, value: null };
    }

    const mailboxDispatchId = mailboxDispatchResult?.ok
      ? mailboxDispatchResult.value
      : null;
    if (mailboxDispatchId) {
      hyperlaneResult = await settledValue(() =>
        fetchHyperlaneMessageView(mailboxDispatchId),
      );
    }
  }

  return buildTrackingSummaryData({
    orderId: context.orderId,
    sourceChainName: sourceChain.displayName,
    destinationChainName: destinationChain.displayName,
    solverOrderResult,
    sourceOrderStatusResult,
    finalisedLogResult,
    fillReceiptResult: fillReceiptResult?.ok
      ? {
          ok: true,
          value: {
            status: fillReceiptResult.value.status,
            blockNumber: fillReceiptResult.value.blockNumber,
          },
        }
      : fillReceiptResult,
    outputSettlerLogsResult,
    outputFilledResult,
    mailboxDispatchResult,
    hyperlaneResult,
  });
}

async function settledValue<T>(
  fn: () => Promise<T>,
): Promise<SettledResult<T>> {
  try {
    return { ok: true as const, value: await fn() };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Public RPCs often cap `eth_getLogs` to ~50k blocks per request; stay below. */
const FINALISED_LOG_MAX_SPAN = 40_000n;

async function findFinalisedLog(
  publicClient: any,
  inputSettlerAddress: Address,
  orderId: Hex,
  anchorBlock?: bigint,
) {
  const latest = await publicClient.getBlockNumber();
  const start =
    anchorBlock !== undefined
      ? anchorBlock
      : latest > FINALISED_LOG_MAX_SPAN
        ? latest - FINALISED_LOG_MAX_SPAN
        : 0n;

  let lastMatch: {
    blockNumber: string | null;
    transactionHash: Hex | null;
  } | null = null;

  let cursor = start;
  while (cursor <= latest) {
    const chunkEnd =
      cursor + FINALISED_LOG_MAX_SPAN < latest
        ? cursor + FINALISED_LOG_MAX_SPAN
        : latest;
    const logs = await publicClient.getLogs({
      address: inputSettlerAddress,
      event: INPUT_SETTLER_EVENTS_ABI[0],
      args: { orderId },
      fromBlock: cursor,
      toBlock: chunkEnd,
    });
    for (const log of logs) {
      lastMatch = {
        blockNumber: log.blockNumber?.toString() ?? null,
        transactionHash: (log.transactionHash ?? null) as Hex | null,
      };
    }
    cursor = chunkEnd + 1n;
  }
  return lastMatch;
}

async function findOutputSettlerLogs(
  publicClient: any,
  outputSettlerAddress: Address,
  fillTxHash: Hex,
) {
  const receipt = await publicClient.getTransactionReceipt({
    hash: fillTxHash,
  });
  const logs = await publicClient.getLogs({
    address: outputSettlerAddress,
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  const matching = logs.filter(
    (log: any) => log.transactionHash === fillTxHash,
  );
  return {
    blockNumber: receipt.blockNumber.toString(),
    logCount: matching.length,
    topics: matching.map((log: any) => log.topics?.[0] ?? null),
  };
}

/**
 * Scan the destination-chain OutputSettler for an OutputFilled event whose
 * orderId matches the given value.  This is the primary on-chain fallback for
 * fill detection when the Solver API is unavailable or slow to index.
 */
async function findOutputSettlerFillLog(
  publicClient: any,
  outputSettlerAddress: Address,
  orderId: Hex,
  fromBlock?: bigint,
) {
  const latest = await publicClient.getBlockNumber();
  // Use provided fromBlock if available (estimated from open tx timestamp),
  // otherwise fall back to OUTPUT_FILLED_SCAN_LOOKBACK_BLOCKS env-configurable value.
  const start =
    fromBlock !== undefined
      ? fromBlock
      : latest > OUTPUT_FILLED_SCAN_LOOKBACK_BLOCKS
        ? latest - OUTPUT_FILLED_SCAN_LOOKBACK_BLOCKS
        : 0n;
  let cursor = start;
  while (cursor <= latest) {
    const chunkEnd =
      cursor + FINALISED_LOG_MAX_SPAN < latest
        ? cursor + FINALISED_LOG_MAX_SPAN
        : latest;
    const logs = await publicClient.getLogs({
      address: outputSettlerAddress,
      event: OUTPUT_SETTLER_FILL_ABI[0],
      args: { orderId },
      fromBlock: cursor,
      toBlock: chunkEnd,
    });
    if (logs.length > 0) {
      const log = logs[logs.length - 1];
      return {
        blockNumber: log.blockNumber?.toString() ?? null,
        transactionHash: (log.transactionHash ?? null) as Hex | null,
      };
    }
    cursor = chunkEnd + 1n;
  }
  return null;
}

/**
 * Scan fill receipt logs for an OutputFilled event matching the given orderId.
 * This is the most reliable way to detect the event because:
 *  - No extra getLogs RPC call is needed (receipt is already fetched in Phase 2)
 *  - The event is guaranteed to be present if the fill tx succeeded
 */
function extractOutputFilledFromReceipt(
  receiptLogs: readonly {
    address: Address;
    topics: readonly Hex[];
    transactionHash: Hex | null;
    blockNumber: bigint | null;
  }[],
  outputSettlerAddress: Address,
  orderId: Hex,
): OutputFilledCacheEntry {
  const addr = outputSettlerAddress.toLowerCase();
  const t0 = OUTPUT_FILLED_TOPIC0.toLowerCase();
  const t1 = orderId.toLowerCase();
  for (const log of receiptLogs) {
    if (
      log.address.toLowerCase() === addr &&
      log.topics[0]?.toLowerCase() === t0 &&
      log.topics[1]?.toLowerCase() === t1
    ) {
      return {
        blockNumber: log.blockNumber?.toString() ?? null,
        transactionHash: log.transactionHash ?? null,
      };
    }
  }
  return null;
}

/**
 * Scan the Hyperlane Mailbox for the DispatchId of the PostFill transaction.
 *
 * Background:
 *   OutputSettlerSimple.fill() does NOT emit any Hyperlane event.
 *   The solver submits a separate PostFill tx AFTER the fill, calling the
 *   output oracle → Mailbox.dispatch() → emits Dispatch + DispatchId.
 *
 * Strategy (dual-pass, handles multiple Hyperlane ABI versions):
 *   Pass 1 – v3 Dispatch with sender filter (precise, avoids false positives):
 *     event Dispatch(address indexed sender, uint32 indexed destination,
 *                    bytes32 indexed recipient, bytes32 messageId, bytes message)
 *     Filter by sender = outputOracleAddress.  messageId is in event data.
 *
 *   Pass 2 – DispatchId fallback (consistent across Hyperlane v2 and v3):
 *     event DispatchId(bytes32 indexed messageId)
 *     No sender filter; returns the first DispatchId found in the scan window.
 *     Less precise but always correct in single-order test environments.
 *
 * EVM chains store only bytecode, so the ABI cannot be fetched from the chain.
 * The dual-pass approach makes this function robust without external ABI services.
 */
async function findMailboxDispatchIdAfterFill(
  publicClient: any,
  mailboxAddress: Address,
  outputOracleAddress: Address | undefined,
  fillBlock: bigint,
): Promise<Hex | null> {
  const latest = await publicClient.getBlockNumber();
  const toBlock =
    latest < fillBlock + HYPERLANE_POST_FILL_SCAN_BLOCKS
      ? latest
      : fillBlock + HYPERLANE_POST_FILL_SCAN_BLOCKS;

  // Pass 1: v3 Dispatch with sender filter (precise)
  if (outputOracleAddress) {
    try {
      const logs = await publicClient.getLogs({
        address: mailboxAddress,
        event: HYPERLANE_MAILBOX_DISPATCH_ABI,
        args: { sender: outputOracleAddress },
        fromBlock: fillBlock,
        toBlock,
      });
      if (logs.length > 0) {
        return (logs[0].args.messageId ?? null) as Hex | null;
      }
    } catch {
      // Dispatch ABI may not match this Mailbox version; fall through to pass 2.
    }
  }

  // Pass 2: DispatchId fallback (works with all Hyperlane versions)
  try {
    const idLogs = await publicClient.getLogs({
      address: mailboxAddress,
      event: HYPERLANE_MAILBOX_EVENTS_ABI[0], // DispatchId(bytes32 indexed messageId)
      fromBlock: fillBlock,
      toBlock,
    });
    if (idLogs.length > 0) {
      return (idLogs[0].args.messageId ?? null) as Hex | null;
    }
  } catch {
    // ignore
  }

  return null;
}

/** @deprecated Use findMailboxDispatchIdAfterFill instead. Kept for reference only. */
async function findMailboxDispatchId(
  publicClient: any,
  mailboxAddress: Address,
  fillTxHash: Hex,
) {
  const receipt = await publicClient.getTransactionReceipt({
    hash: fillTxHash,
  });
  const logs = await publicClient.getLogs({
    address: mailboxAddress,
    event: HYPERLANE_MAILBOX_EVENTS_ABI[0],
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  const matching = logs.find((log: any) => log.transactionHash === fillTxHash);
  return matching?.args?.messageId ?? null;
}

async function fetchHyperlaneMessageView(messageId: Hex) {
  const response = await fetch("https://api.hyperlane.xyz/v1/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `query($msgId: String!) {
  message_view(where: { msg_id: { _eq: $msgId } }) {
    msg_id
    is_delivered
    delivery_tx_id
    origin_domain_id
    destination_domain_id
    origin_tx_id
    send_occurred_at
    delivery_occurred_at
  }
}`,
      variables: {
        msgId: `\\x${messageId.slice(2)}`,
      },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Hyperlane GraphQL ${response.status}: ${text}`);
  }
  const data = JSON.parse(text) as {
    data?: {
      message_view?: Array<Record<string, unknown>>;
    };
  };
  return data.data?.message_view?.[0] ?? null;
}

function pickEscrowQuote(quotes: QuoteResponse[]) {
  const quote = quotes.find((item) => item.order?.type === "oif-escrow-v0");
  if (!quote) {
    const types = quotes
      .map((item) => item.order?.type ?? "unknown")
      .join(", ");
    throw new Error(`找不到 oif-escrow-v0 quote，可用類型: ${types}`);
  }
  if (!quote.quoteId) {
    throw new Error("quote 回應缺少 quoteId。");
  }
  if (!quote.order?.payload?.types) {
    throw new Error("quote payload 缺少 EIP-712 types，無法簽名。");
  }
  return quote;
}

async function signQuoteOrder(
  account: ReturnType<typeof privateKeyToAccount>,
  order: QuoteOrder,
): Promise<Hex> {
  if (order.type === "oif-escrow-v0") {
    const digest = reconstructPermit2Digest(order.payload);
    const rawSignature = await account.sign({ hash: digest });
    const recoveredSigner = await recoverAddress({
      hash: digest,
      signature: rawSignature,
    });

    if (recoveredSigner.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(
        `本地簽名驗證失敗: recovered signer ${recoveredSigner} 與帳戶 ${account.address} 不符。`,
      );
    }

    const witnessUser = readPermit2WitnessUser(order.payload.message);
    if (
      witnessUser &&
      witnessUser.toLowerCase() !== account.address.toLowerCase()
    ) {
      console.warn(
        `警告: quote 內 witness.user=${witnessUser}，但實際簽名帳戶=${account.address}。鏈上可能因 signer 不符而失敗。`,
      );
    }

    console.log(`Permit2 signer 驗證通過: ${recoveredSigner}`);
    return withSignaturePrefix(order.type, rawSignature);
  }

  const payload = order.payload;
  const allTypes = payload.types ?? {};
  const signTypes = Object.fromEntries(
    Object.entries(allTypes).filter(([name]) => name !== "EIP712Domain"),
  );

  const normalizedMessage = normalizeValueForType(
    payload.primaryType,
    payload.message,
    signTypes,
  );

  const signer = account as {
    signTypedData(args: {
      domain: Record<string, unknown>;
      primaryType: string;
      types: Record<string, TypeField[]>;
      message: unknown;
    }): Promise<Hex>;
  };

  const rawSignature = await signer.signTypedData({
    domain: normalizeDomain(payload.domain),
    primaryType: payload.primaryType,
    types: signTypes,
    message: normalizedMessage,
  });

  return withSignaturePrefix(order.type, rawSignature);
}

function withSignaturePrefix(orderType: string, signature: Hex): Hex {
  switch (orderType) {
    case "oif-escrow-v0":
      return `0x00${signature.slice(2)}` as Hex;
    case "oif-3009-v0":
      return `0x01${signature.slice(2)}` as Hex;
    case "oif-resource-lock-v0":
      return signature;
    default:
      throw new Error(`未知的 order type，無法補簽名前綴: ${orderType}`);
  }
}

function reconstructPermit2Digest(payload: OrderPayload): Hex {
  const domainName = stringValue(payload.domain.name, "domain.name");
  const chainId = bigintValue(payload.domain.chainId, "domain.chainId");
  const verifyingContract = addressValue(
    payload.domain.verifyingContract,
    "domain.verifyingContract",
  );

  const message = payload.message;
  const spender = addressValue(message.spender, "message.spender");
  const nonce = bigintValue(message.nonce, "message.nonce");
  const deadline = bigintValue(message.deadline, "message.deadline");
  const permitted = arrayValue(message.permitted, "message.permitted");
  const witness = objectValue(message.witness, "message.witness");
  const outputs = arrayValue(witness.outputs, "message.witness.outputs");

  const domainHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(stringValueToHex(domainName)),
        chainId,
        verifyingContract,
      ],
    ),
  );

  const permittedHashes = permitted.map((item, index) => {
    const permission = objectValue(item, `message.permitted[${index}]`);
    return keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [
          TOKEN_PERMISSIONS_TYPEHASH,
          addressValue(permission.token, `message.permitted[${index}].token`),
          bigintValue(permission.amount, `message.permitted[${index}].amount`),
        ],
      ),
    );
  });

  const permittedHash = keccak256(
    permittedHashes.length === 0 ? "0x" : concatHex(permittedHashes),
  );

  const outputHashes = outputs.map((item, index) => {
    const output = objectValue(item, `message.witness.outputs[${index}]`);
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
        ],
        [
          MANDATE_OUTPUT_TYPEHASH,
          bytes32Value(
            output.oracle,
            `message.witness.outputs[${index}].oracle`,
          ),
          bytes32Value(
            output.settler,
            `message.witness.outputs[${index}].settler`,
          ),
          bigintValue(
            output.chainId,
            `message.witness.outputs[${index}].chainId`,
          ),
          bytes32Value(output.token, `message.witness.outputs[${index}].token`),
          bigintValue(
            output.amount,
            `message.witness.outputs[${index}].amount`,
          ),
          bytes32Value(
            output.recipient,
            `message.witness.outputs[${index}].recipient`,
          ),
          keccak256(
            hexValue(
              output.callbackData,
              "message.witness.outputs[].callbackData",
            ),
          ),
          keccak256(
            hexValue(output.context, "message.witness.outputs[].context"),
          ),
        ],
      ),
    );
  });

  const outputsHash = keccak256(
    outputHashes.length === 0 ? "0x" : concatHex(outputHashes),
  );

  const witnessHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint32" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [
        PERMIT2_WITNESS_TYPEHASH,
        addressValue(witness.user, "message.witness.user"),
        numberValue(witness.expires, "message.witness.expires"),
        addressValue(witness.inputOracle, "message.witness.inputOracle"),
        outputsHash,
      ],
    ),
  );

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        PERMIT2_ORDER_TYPEHASH,
        permittedHash,
        spender,
        nonce,
        deadline,
        witnessHash,
      ],
    ),
  );

  return keccak256(concatHex(["0x1901", domainHash, structHash]));
}

function readPermit2WitnessUser(message: Record<string, unknown>) {
  const witness = message.witness;
  if (!witness || typeof witness !== "object") {
    return undefined;
  }

  const user = (witness as Record<string, unknown>).user;
  return typeof user === "string" ? user : undefined;
}

function buildStandardOrderFromEscrowQuote(order: QuoteOrder): StandardOrder {
  if (order.type !== "oif-escrow-v0") {
    throw new Error(`open() 目前只支援 oif-escrow-v0，收到 ${order.type}`);
  }

  const payload = order.payload;
  const message = objectValue(payload.message, "order.payload.message");
  const witness = objectValue(message.witness, "order.payload.message.witness");
  const permitted = arrayValue(
    message.permitted,
    "order.payload.message.permitted",
  );
  const outputs = arrayValue(
    witness.outputs,
    "order.payload.message.witness.outputs",
  );

  return {
    user: addressValue(witness.user, "order.payload.message.witness.user"),
    nonce: bigintValue(message.nonce, "order.payload.message.nonce"),
    originChainId: bigintValue(
      payload.domain.chainId,
      "order.payload.domain.chainId",
    ),
    expires: numberValue(
      witness.expires,
      "order.payload.message.witness.expires",
    ),
    fillDeadline: numberValue(
      message.deadline,
      "order.payload.message.deadline",
    ),
    inputOracle: addressValue(
      witness.inputOracle,
      "order.payload.message.witness.inputOracle",
    ),
    inputs: permitted.map((item, index) => {
      const permission = objectValue(
        item,
        `order.payload.message.permitted[${index}]`,
      );
      return [
        addressToUint256(
          addressValue(
            permission.token,
            `order.payload.message.permitted[${index}].token`,
          ),
        ),
        bigintValue(
          permission.amount,
          `order.payload.message.permitted[${index}].amount`,
        ),
      ];
    }),
    outputs: outputs.map((item, index) => {
      const output = objectValue(
        item,
        `order.payload.message.witness.outputs[${index}]`,
      );
      return {
        oracle: bytes32Value(
          output.oracle,
          `order.payload.message.witness.outputs[${index}].oracle`,
        ),
        settler: bytes32Value(
          output.settler,
          `order.payload.message.witness.outputs[${index}].settler`,
        ),
        chainId: bigintValue(
          output.chainId,
          `order.payload.message.witness.outputs[${index}].chainId`,
        ),
        token: bytes32Value(
          output.token,
          `order.payload.message.witness.outputs[${index}].token`,
        ),
        amount: bigintValue(
          output.amount,
          `order.payload.message.witness.outputs[${index}].amount`,
        ),
        recipient: bytes32Value(
          output.recipient,
          `order.payload.message.witness.outputs[${index}].recipient`,
        ),
        callbackData: hexValue(
          output.callbackData,
          `order.payload.message.witness.outputs[${index}].callbackData`,
        ),
        context: hexValue(
          output.context,
          `order.payload.message.witness.outputs[${index}].context`,
        ),
      };
    }),
  };
}

function normalizeDomain(domain: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(domain)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (key === "chainId") {
      normalized.chainId = Number(value);
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
}

function normalizeValueForType(
  typeName: string,
  value: unknown,
  types: Record<string, TypeField[]>,
): unknown {
  if (typeName.endsWith("[]")) {
    if (!Array.isArray(value)) {
      throw new Error(`型別 ${typeName} 預期是陣列。`);
    }
    const nestedType = typeName.slice(0, -2);
    return value.map((item) => normalizeValueForType(nestedType, item, types));
  }

  if (/^u?int[0-9]*$/u.test(typeName)) {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number") {
      return BigInt(value);
    }
    if (typeof value === "string") {
      return BigInt(value);
    }
    throw new Error(`型別 ${typeName} 需要整數值。`);
  }

  if (typeName === "bool") {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    throw new Error("bool 型別只能是 true 或 false。");
  }

  if (
    typeName === "address" ||
    typeName === "string" ||
    typeName === "bytes" ||
    /^bytes[0-9]+$/u.test(typeName)
  ) {
    return value;
  }

  const fields = types[typeName];
  if (!fields) {
    return value;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`型別 ${typeName} 需要物件值。`);
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const field of fields) {
    const fieldValue = input[field.name];
    if (fieldValue === undefined || fieldValue === null) {
      continue;
    }
    output[field.name] = normalizeValueForType(field.type, fieldValue, types);
  }

  return output;
}

function buildQuoteRequest(args: {
  fromChainId: number;
  toChainId: number;
  accountAddress: Address;
  receiver: Address;
  fromTokenAddress: Address;
  toTokenAddress: Address;
  amount: string;
  minOutput?: string;
}) {
  return {
    user: encodeInteropAddress(args.fromChainId, args.accountAddress),
    intent: {
      intentType: "oif-swap",
      inputs: [
        {
          user: encodeInteropAddress(args.fromChainId, args.accountAddress),
          asset: encodeInteropAddress(args.fromChainId, args.fromTokenAddress),
          amount: args.amount,
        },
      ],
      outputs: [
        {
          receiver: encodeInteropAddress(args.toChainId, args.receiver),
          asset: encodeInteropAddress(args.toChainId, args.toTokenAddress),
          ...(args.minOutput ? { amount: args.minOutput } : {}),
        },
      ],
      swapType: "exact-input",
      partialFill: false,
      originSubmission: {
        mode: "user",
        schemes: ["permit2"],
      },
    },
    supportedTypes: ["oif-escrow-v0"],
  };
}

async function resolveTokenMetadata(
  chainId: number,
  token: TokenKey,
): Promise<TokenMetadata> {
  try {
    const networkAssets = await fetchJson<NetworkAssetsResponse>(
      `${SOLVER_BASE_URL}/assets/${chainId}`,
    );

    const asset = networkAssets.assets.find(
      (item) => item.symbol.toUpperCase() === token,
    );

    if (asset) {
      return {
        symbol: asset.symbol,
        address: asset.address,
        decimals: asset.decimals,
      };
    }
  } catch (error) {
    console.warn(
      `無法從 solver /assets/${chainId} 解析 ${token}，改用預設地址。`,
      error instanceof Error ? error.message : error,
    );
  }

  const fallback = FALLBACK_TOKEN_MAP[chainId]?.[token];
  if (!fallback || fallback === zeroAddress) {
    throw new Error(`鏈 ${chainId} 沒有 ${token} 的預設地址。`);
  }
  return {
    symbol: token,
    address: fallback,
    decimals: FALLBACK_TOKEN_DECIMALS[token],
  };
}

async function resolveTokenAddress(
  chainId: number,
  token: TokenKey,
): Promise<Address> {
  return (await resolveTokenMetadata(chainId, token)).address;
}

function resolveInputSettlerAddress(chainId: number): Address {
  const settler = INPUT_SETTLER_MAP[chainId];
  if (!settler) {
    throw new Error(`鏈 ${chainId} 沒有 input settler 預設地址。`);
  }
  return settler;
}

function resolveOpenInputSettlerAddress(
  flags: Record<string, string | boolean>,
  chainId: number,
  quoteSpender: Address,
) {
  const explicit = stringFlag(flags, "input-settler");
  if (explicit) {
    return addressValue(explicit, "--input-settler");
  }

  if (quoteSpender !== zeroAddress) {
    return quoteSpender;
  }

  return resolveInputSettlerAddress(chainId);
}

function resolveSettlerSpenderForManualApprove(
  flags: Record<string, string | boolean>,
  chainId: number,
) {
  const explicit = stringFlag(flags, "spender-address");
  if (explicit) {
    return addressValue(explicit, "--spender-address");
  }
  return resolveInputSettlerAddress(chainId);
}

function buildAllowanceTargetsForDoctor(
  chainId: number,
  quoteSpender: Address,
) {
  const seen = new Set<string>();
  const targets = [
    { label: "報價提供的 Spender", address: quoteSpender },
    {
      label: "預設備援 Input Settler",
      address: INPUT_SETTLER_MAP[chainId] ?? zeroAddress,
    },
    { label: "Permit2", address: PERMIT2_ADDRESS },
  ];

  return targets.filter((target) => {
    if (!isAddress(target.address) || target.address === zeroAddress) {
      return false;
    }
    const key = target.address.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function ensureAllowance(args: {
  publicClient: {
    readContract(args: unknown): Promise<unknown>;
    waitForTransactionReceipt(args: { hash: Hex }): Promise<unknown>;
  };
  walletClient: {
    writeContract(args: unknown): Promise<Hex>;
  };
  tokenAddress: Address;
  owner: Address;
  spender: Address;
  spenderLabel: string;
  requiredAmount: bigint;
  autoApprove: boolean;
  approveAmount?: bigint;
  explorerBaseUrl: string;
  insufficientHint?: string[];
}) {
  const currentAllowance = (await args.publicClient.readContract({
    address: args.tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [args.owner, args.spender],
  })) as bigint;

  console.log(`${args.spenderLabel}: ${args.spender}`);
  console.log(`目前 allowance: ${currentAllowance.toString()}`);

  if (currentAllowance >= args.requiredAmount) {
    console.log(`${args.spenderLabel} allowance 已足夠。`);
    return;
  }

  if (!args.autoApprove) {
    throw new Error(
      [
        `${args.spenderLabel} allowance 不足，當前=${currentAllowance}，所需至少=${args.requiredAmount}。`,
        ...(args.insufficientHint ?? []),
      ].join("\n"),
    );
  }

  console.log(`allowance 不足，先自動送出 approve 給 ${args.spenderLabel}...`);
  const approvalTarget = args.approveAmount ?? args.requiredAmount;
  const approveHash = await args.walletClient.writeContract({
    address: args.tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    chain: undefined,
    args: [args.spender, approvalTarget],
  });
  console.log(`approve tx: ${approveHash}`);
  console.log(`Explorer: ${args.explorerBaseUrl}/tx/${approveHash}`);
  await args.publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`approve 已確認，核准數量=${approvalTarget.toString()}。`);
}

function addressToUint256(address: Address) {
  return BigInt(address);
}

function encodeInteropAddress(chainId: number, address: Address): Hex {
  return encodeAddress(
    {
      version: 1,
      chainType: "eip155",
      chainReference: String(chainId),
      address,
    },
    {
      format: "hex",
    },
  ) as Hex;
}

function parseChain(value: string): ChainKey {
  const normalized = value.trim().toLowerCase();
  if (normalized === "sepolia" || normalized === "ethereum-sepolia") {
    return "sepolia";
  }
  if (normalized === "base-sepolia" || normalized === "base") {
    return "base-sepolia";
  }
  throw new Error(`不支援的鏈別: ${value}`);
}

function parseToken(value: string): TokenKey {
  const normalized = value.trim().toUpperCase();
  if (normalized === "USDC" || normalized === "EURC") {
    return normalized;
  }
  throw new Error(`不支援的 token: ${value}`);
}

function parseFlags(args: string[]) {
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) {
      throw new Error(`無法解析參數: ${current}`);
    }

    const key = current.slice(2);
    const next = args[index + 1];

    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return flags;
}

function requiredFlag(flags: Record<string, string | boolean>, key: string) {
  const value = flags[key];
  if (!value || typeof value !== "string") {
    throw new Error(`缺少必要參數 --${key}`);
  }
  return value;
}

function stringFlag(flags: Record<string, string | boolean>, key: string) {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

async function requestQuoteWithGuidance(
  requestBody: Record<string, unknown>,
  context: SwapContext,
) {
  try {
    return await fetchJson<QuotesApiResponse>(`${SOLVER_BASE_URL}/quotes`, {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("cannot be zero after cost adjustment")) {
      throw error;
    }

    const suggestion = await findMinimumViableQuote(
      requestBody,
      BigInt(context.amount),
    );

    const nextStep = suggestion.minimumAmount
      ? `建議先改用至少 ${suggestion.minimumAmount} 的輸入量再試一次。`
      : "建議改用更大的輸入量再試一次。";

    throw new Error(
      [
        "目前輸入量過小，扣除跨鏈成本後輸出會變成 0。",
        `${context.fromChainKey} ${context.fromTokenKey} -> ${context.toChainKey} ${context.toTokenKey}`,
        nextStep,
        `原始錯誤: ${message}`,
      ].join("\n"),
    );
  }
}

async function findMinimumViableQuote(
  requestBody: Record<string, unknown>,
  initialAmount: bigint,
) {
  const firstProbe = await probeQuoteAtAmount(requestBody, initialAmount);

  let low = 0n;
  let high: bigint | undefined;
  let bestResponse: QuotesApiResponse | undefined;

  if (firstProbe.ok) {
    high = initialAmount;
    bestResponse = firstProbe.response;

    let probe = initialAmount;
    while (probe > 1n) {
      const next = probe / 2n;
      if (next < 1n) {
        break;
      }

      const result = await probeQuoteAtAmount(requestBody, next);
      if (result.ok) {
        high = next;
        bestResponse = result.response;
        probe = next;
        continue;
      }
      if (result.reason === "zero") {
        low = next;
        break;
      }
      return {};
    }
  } else {
    if (firstProbe.reason !== "zero") {
      return {};
    }

    low = initialAmount;
    let probe = initialAmount;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      probe *= 2n;
      const result = await probeQuoteAtAmount(requestBody, probe);
      if (result.ok) {
        high = probe;
        bestResponse = result.response;
        break;
      }
      if (result.reason !== "zero") {
        return {};
      }
    }
  }

  if (!high || !bestResponse) {
    return {};
  }

  let upper = high;

  while (upper - low > 1n) {
    const mid: bigint = (low + upper) / 2n;
    const result = await probeQuoteAtAmount(requestBody, mid);
    if (result.ok) {
      upper = mid;
      bestResponse = result.response;
      continue;
    }
    if (result.reason === "zero") {
      low = mid;
      continue;
    }
    return {};
  }

  return {
    minimumAmount: upper.toString(),
    response: bestResponse,
  };
}

async function probeQuoteAtAmount(
  requestBody: Record<string, unknown>,
  amount: bigint,
): Promise<
  | { ok: true; response: QuotesApiResponse }
  | { ok: false; reason: "zero" | "other" }
> {
  const working = structuredClone(requestBody);
  const intent = objectValue(working.intent, "intent");
  const inputs = arrayValue(intent.inputs, "intent.inputs");
  const firstInput = objectValue(inputs[0], "intent.inputs[0]");
  firstInput.amount = amount.toString();

  try {
    const response = await fetchJson<QuotesApiResponse>(
      `${SOLVER_BASE_URL}/quotes`,
      {
        method: "POST",
        body: JSON.stringify(working),
      },
    );
    return { ok: true, response };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("cannot be zero after cost adjustment")) {
      return { ok: false, reason: "zero" };
    }
    return { ok: false, reason: "other" };
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${JSON.stringify(data, null, 2)}`,
    );
  }

  return data as T;
}

async function fetchSolverOrder(orderId: string) {
  const response = await fetchJson<
    SolverOrderRecord | { order: SolverOrderRecord }
  >(`${SOLVER_BASE_URL}/orders/${orderId}`);

  return "order" in response ? response.order : response;
}

async function saveOpenOrderRecord(record: StoredOpenOrderRecord) {
  await mkdir(ORDER_CACHE_DIR, { recursive: true });
  const filePath = join(ORDER_CACHE_DIR, `${record.orderId}.json`);
  await writeFile(filePath, stringifyWithBigInt(record), "utf8");
  return filePath;
}

async function loadStoredOrderRecord(flags: Record<string, string | boolean>) {
  const orderFile = stringFlag(flags, "order-file");
  const orderId = stringFlag(flags, "order-id");
  const filePath =
    orderFile ??
    (orderId ? join(ORDER_CACHE_DIR, `${orderId}.json`) : undefined);

  if (!filePath) {
    throw new Error("請提供 --order-file 或 --order-id 以載入已保存的 order。");
  }

  const raw = await readTextFile(filePath, "utf8");
  return JSON.parse(raw, reviveBigIntJson) as StoredOpenOrderRecord;
}

function stringifyWithBigInt(value: unknown) {
  return JSON.stringify(
    value,
    (_key, current) =>
      typeof current === "bigint"
        ? { __type: "bigint", value: current.toString() }
        : current,
    2,
  );
}

function reviveBigIntJson(_key: string, value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "__type" in value &&
    "value" in value
  ) {
    const typedValue = value as { __type?: unknown; value?: unknown };
    if (
      typedValue.__type === "bigint" &&
      typeof typedValue.value === "string"
    ) {
      return BigInt(typedValue.value);
    }
  }
  return value;
}

function stringValue(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} 必須是字串。`);
  }
  return value;
}

function bigintValue(value: unknown, label: string) {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (typeof value === "string") {
    return BigInt(value);
  }
  throw new Error(`${label} 必須是整數字串或數字。`);
}

function numberValue(value: unknown, label: string) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  throw new Error(`${label} 必須是數字。`);
}

function objectValue(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必須是物件。`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必須是陣列。`);
  }
  return value;
}

function addressValue(value: unknown, label: string) {
  const address = stringValue(value, label);
  if (!isAddress(address)) {
    throw new Error(`${label} 不是合法地址: ${address}`);
  }
  return address as Address;
}

function hexValue(value: unknown, label: string) {
  const hex = stringValue(value, label);
  if (!hex.startsWith("0x")) {
    throw new Error(`${label} 必須是 0x 開頭的 hex。`);
  }
  return hex as Hex;
}

function bytes32Value(value: unknown, label: string) {
  const hex = hexValue(value, label);
  if (hex.length !== 66) {
    throw new Error(`${label} 必須是 bytes32。`);
  }
  return hex;
}

function stringValueToHex(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex")}` as Hex;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`用法:

0. 服務健康狀態
   npm run health

0b. 取得 quote（POST /quotes 完整回應）
   npm run quotes -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token USDC --amount 1000000

1. 查看 solver 支援資產
   npm run assets

2. 先做 Permit2 approve
   npm run approve-permit2 -- --from-chain sepolia --token USDC --amount max

3. 對 input settler 做 approve（給 open() 用）
   npm run approve-settler -- --from-chain sepolia --token USDC --amount max

5. 探測最小可行輸入量
   npm run quote-min -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token EURC --amount 1000000

6. 不鎖資金 dry-run，檢查 quote / settler / permit2 allowance
   npm run doctor -- --from-chain base-sepolia --to-chain sepolia --from-token EURC --to-token USDC --amount 5000000

7. 走 API + openFor 的原始 off-chain 路徑
   npm run openFor -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token EURC --amount 1000000 --wait

8. 走 on-chain open() workaround 路徑
   npm run open -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token EURC --amount 20000000 --wait

9. 若沒先 approve，可讓 open / openFor 指令自動補精準數量 approve
   npm run open -- --from-chain base-sepolia --to-chain sepolia --from-token EURC --to-token USDC --amount 5000000 --auto-approve --wait
   npm run openFor -- --from-chain sepolia --to-chain base-sepolia --from-token USDC --to-token EURC --amount 1000000 --auto-approve --wait

10. 查詢 solver 訂單狀態
   npm run status -- --order-id 0x...

11. 列出本地已保存、可退款或尚未到期的訂單（會查鏈上狀態）
   npm run refund -- --list

12. 列出訂單時，順手清掉已鏈上退款的本地 cache
   npm run refund -- --list --prune

13. 使用已保存的 order 檔做 refund（需等待 expires 之後）
   npm run refund -- --order-id 0x...

支援鏈:
  sepolia
  base-sepolia

支援 token:
  USDC
  EURC

額外參數:
  --spender-address 0x...
  --input-settler 0x...
  --order-file /path/to/order.json
  --list
  --prune
`);
}

const invokedPath = process.argv[1];
const isDirectExecution =
  typeof invokedPath === "string" &&
  pathToFileURL(invokedPath).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
