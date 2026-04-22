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
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "5000");
const ORDER_TIMEOUT_MS = Number(process.env.ORDER_TIMEOUT_MS ?? "600000");
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

  await ensureBalance({
    publicClient,
    tokenAddress: fromToken.address,
    owner: account.address,
    requiredAmount: totalInputAmount,
    tokenLabel: `${fromChain.displayName} ${fromTokenKey}`,
  });

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

  if (waitForOrder && orderResponse.orderId) {
    await waitForOrderCompletion(orderResponse.orderId, {
      orderId: orderResponse.orderId,
      sourceChainKey: fromChainKey,
      destinationChainKey: toChainKey,
      inputSettlerAddress:
        quoteSpender !== zeroAddress
          ? quoteSpender
          : resolveInputSettlerAddress(fromChain.chainId),
      outputSettlerAddress: OUTPUT_SETTLER_MAP[toChain.chainId],
      standardOrder,
    });
  }
}

async function handleOpen(flags: Record<string, string | boolean>) {
  const fromChainKey = parseChain(requiredFlag(flags, "from-chain"));
  const toChainKey = parseChain(requiredFlag(flags, "to-chain"));
  const fromTokenKey = parseToken(requiredFlag(flags, "from-token"));
  const toTokenKey = parseToken(requiredFlag(flags, "to-token"));
  const amount = requiredFlag(flags, "amount");
  const minOutput = stringFlag(flags, "min-output");
  const waitForSolver = Boolean(flags.wait);
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

  const quoteResponse = await requestQuoteWithGuidance(
    requestBody,
    swapContext,
  );
  const quote = pickEscrowQuote(quoteResponse.quotes);
  const standardOrder = buildStandardOrderFromEscrowQuote(quote.order);

  if (standardOrder.user.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `quote 內的 order.user=${standardOrder.user} 與當前帳戶 ${account.address} 不符，無法直接呼叫 open()。`,
    );
  }

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

  const publicClient = createPublicClient({
    chain: fromChain.viemChain,
    transport: http(fromChain.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: fromChain.viemChain,
    transport: http(fromChain.rpcUrl),
  });

  await ensureBalance({
    publicClient,
    tokenAddress: fromToken.address,
    owner: account.address,
    requiredAmount: totalInputAmount,
    tokenLabel: `${fromChain.displayName} ${fromTokenKey}`,
  });

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

  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      address: inputSettlerAddress,
      abi: INPUT_SETTLER_ABI,
      functionName: "open",
      args: [standardOrder],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw error;
  }

  console.log(`open() tx: ${txHash}`);
  console.log(`Explorer: ${fromChain.explorerBaseUrl}/tx/${txHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  if (receipt.status !== "success") {
    throw new Error("open() 交易失敗。");
  }
  console.log(`open() 已確認，block=${receipt.blockNumber}`);
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

  if (waitForSolver) {
    await waitForOnchainOrderCompletion(orderId, {
      orderId,
      sourceChainKey: fromChainKey,
      destinationChainKey: toChainKey,
      inputSettlerAddress,
      outputSettlerAddress: OUTPUT_SETTLER_MAP[toChain.chainId],
      standardOrder,
      openTxHash: txHash,
    });
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

async function waitForOrderCompletion(
  orderId: string,
  trackingContext?: OrderTrackingContext,
) {
  console.log("開始以多來源輪詢訂單狀態...");
  const deadline = Date.now() + ORDER_TIMEOUT_MS;
  let lastStatus = "";
  let warnedMissingOrder = false;
  let lastTrackingSnapshot = "";

  while (Date.now() < deadline) {
    if (trackingContext) {
      lastTrackingSnapshot = await printTrackingSnapshotIfChanged(
        trackingContext,
        lastTrackingSnapshot,
      );
    }
    try {
      const order = await fetchSolverOrder(orderId);
      lastStatus = printStatusIfChanged(orderId, order, lastStatus);

      if (isTerminalStatus(order.status)) {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('"error": "ORDER_NOT_FOUND"')) {
        if (!warnedMissingOrder) {
          console.log("訂單已送出，但 solver 尚未完成索引，等待後重試...");
          warnedMissingOrder = true;
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw error;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`輪詢逾時，請手動查詢訂單狀態: ${orderId}`);
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
) {
  const candidates = [orderId.slice(2), orderId];
  console.log("開始以多來源輪詢 solver 是否已偵測到 on-chain 訂單...");
  const deadline = Date.now() + ORDER_TIMEOUT_MS;
  let detectedOrderId: string | undefined;
  let lastStatus = "";
  let lastTrackingSnapshot = "";

  while (Date.now() < deadline) {
    if (trackingContext) {
      lastTrackingSnapshot = await printTrackingSnapshotIfChanged(
        trackingContext,
        lastTrackingSnapshot,
      );
    }
    let found = false;

    for (const candidate of candidates) {
      try {
        const order = await fetchSolverOrder(candidate);

        found = true;
        if (!detectedOrderId) {
          detectedOrderId = candidate;
          console.log(`solver 已偵測到訂單: ${candidate}`);
        }
        lastStatus = printStatusIfChanged(candidate, order, lastStatus);

        if (isTerminalStatus(order.status)) {
          return;
        }

        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('"error": "ORDER_NOT_FOUND"')) {
          throw error;
        }
      }
    }

    if (!found && !detectedOrderId) {
      console.log("solver 尚未偵測到 open 事件，等待後重試...");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`輪詢逾時，solver 仍未完成 on-chain 訂單處理: ${orderId}`);
}

function printTrackingSnapshotSections(snapshot: Record<string, unknown>) {
  console.log("多來源追蹤摘要:");
  const orderId = snapshot["訂單識別"];
  if (orderId !== undefined) {
    console.log(`訂單識別: ${String(orderId)}`);
  }
  const sections: Array<[string, string]> = [
    ["來源鏈", "來源鏈"],
    ["solver", "solver"],
    ["目的鏈", "目的鏈"],
    ["Hyperlane", "Hyperlane"],
  ];
  for (const [title, key] of sections) {
    console.log(`--- ${title} ---`);
    console.log(JSON.stringify(snapshot[key] ?? null, null, 2));
  }
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

async function buildTrackingSnapshot(context: OrderTrackingContext) {
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

  const solverOrderResult = await settledValue(() =>
    fetchSolverOrder(context.orderId),
  );
  const sourceOrderStatusResult = normalizedOrderId
    ? await settledValue(() =>
        fetchOnchainOrderStatus(
          sourceClient,
          context.inputSettlerAddress,
          normalizedOrderId,
        ),
      )
    : {
        ok: false as const,
        error: "orderId 不是 bytes32，無法查鏈上 orderStatus",
      };
  let finalisedAnchorBlock: bigint | undefined;
  const openTxHashForAnchor = context.openTxHash;
  if (normalizedOrderId && openTxHashForAnchor) {
    const anchorResult = await settledValue(() =>
      sourceClient.getTransactionReceipt({ hash: openTxHashForAnchor }),
    );
    if (anchorResult.ok) {
      finalisedAnchorBlock = anchorResult.value.blockNumber;
    }
  }

  const finalisedLogResult = normalizedOrderId
    ? await settledValue(() =>
        findFinalisedLog(
          sourceClient,
          context.inputSettlerAddress,
          normalizedOrderId,
          finalisedAnchorBlock,
        ),
      )
    : {
        ok: false as const,
        error: "orderId 不是 bytes32，無法掃 Finalised 事件",
      };

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

  const fillTxHash =
    solverOrderResult.ok && solverOrderResult.value.fillTransaction?.hash
      ? (solverOrderResult.value.fillTransaction.hash as Hex)
      : undefined;

  if (fillTxHash) {
    fillReceiptResult = await settledValue(() =>
      destinationClient.getTransactionReceipt({ hash: fillTxHash }),
    );
    outputSettlerLogsResult = await settledValue(() =>
      findOutputSettlerLogs(
        destinationClient,
        context.outputSettlerAddress,
        fillTxHash,
      ),
    );
    mailboxDispatchResult = await settledValue(() =>
      findMailboxDispatchId(
        destinationClient,
        HYPERLANE_MAILBOX_MAP[destinationChain.chainId],
        fillTxHash,
      ),
    );
    const mailboxDispatchId = mailboxDispatchResult.ok
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
