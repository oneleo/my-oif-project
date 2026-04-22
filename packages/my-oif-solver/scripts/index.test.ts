import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDoctorReportData,
  buildOrderPreviewData,
  buildTrackingSummaryData,
} from "./index.js";

const sampleOrder: any = {
  user: "0x1111111111111111111111111111111111111111",
  nonce: 1n,
  originChainId: 84532n,
  expires: 1_800_000_000,
  fillDeadline: 1_700_000_000,
  inputOracle: "0x2222222222222222222222222222222222222222",
  inputs: [
    [
      BigInt(
        "0x000000000000000000000000036CbD53842c5426634e7929541eC2318f3dCF7e",
      ),
      5_000_000n,
    ],
  ],
  outputs: [
    {
      oracle:
        "0x00000000000000000000000058Ce84331d53268430586dB120c0463859fd02Fc",
      settler:
        "0x00000000000000000000000007C262912467800B0AA9B2E1bd44DC8ceCfB90Eb",
      chainId: 11155111n,
      token:
        "0x0000000000000000000000001c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      amount: 4_900_000n,
      recipient:
        "0x0000000000000000000000003333333333333333333333333333333333333333",
      callbackData: "0x12345678abcdef",
      context: "0xabcdef123456",
    },
  ],
};

const fromToken = {
  symbol: "USDC",
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  decimals: 6,
} as const;

const toToken = {
  symbol: "EURC",
  address: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4",
  decimals: 6,
} as const;

test("buildOrderPreviewData formats token amounts with decimals", () => {
  const preview = buildOrderPreviewData({
    actionLabel: "openFor",
    sourceChainName: "Base Sepolia",
    destinationChainName: "Ethereum Sepolia",
    fromToken,
    toToken,
    receiver: "0x3333333333333333333333333333333333333333",
    standardOrder: sampleOrder,
    quoteId: "quote-1",
    quoteType: "oif-escrow-v0",
    quoteSpender: "0x8429Ba4323b2131aA7FB1947E20dB479030c12c1",
    signature: "0xabcdef1234567890fedcba",
  });

  assert.equal(preview["輸入數量"], "5 USDC");
  const standardOrder = preview["StandardOrder"] as Record<string, unknown>;
  const inputs = standardOrder["Inputs"] as Array<Record<string, unknown>>;
  const outputs = standardOrder["Outputs"] as Array<Record<string, unknown>>;
  assert.equal(inputs[0]["人類可讀數量"], "5 USDC");
  assert.equal(outputs[0]["人類可讀數量"], "4.9 EURC");
  assert.equal(preview["使用者簽章"], "0xabcdef1234...dcba");
  assert.equal(outputs[0]["CallbackData"], "0x12345678abc...");
});

test("buildTrackingSummaryData supports mocked multi-source tracker results", () => {
  const summary = buildTrackingSummaryData({
    orderId:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceChainName: "Base Sepolia",
    destinationChainName: "Ethereum Sepolia",
    solverOrderResult: {
      ok: true,
      value: {
        status: "executed",
        updatedAt: 123,
        fillTransaction: {
          hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          status: "confirmed",
          timestamp: 456,
        },
      },
    },
    sourceOrderStatusResult: {
      ok: true,
      value: { code: 1, label: "Deposited" },
    },
    finalisedLogResult: {
      ok: true,
      value: {
        blockNumber: "12345",
        transactionHash:
          "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    },
    fillReceiptResult: {
      ok: true,
      value: { status: "success", blockNumber: 999n },
    },
    outputSettlerLogsResult: {
      ok: true,
      value: {
        blockNumber: "999",
        logCount: 2,
        topics: [
          "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        ],
      },
    },
    mailboxDispatchResult: {
      ok: true,
      value:
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    },
    hyperlaneResult: {
      ok: true,
      value: {
        is_delivered: true,
        destination_domain_id: 11155111,
      },
    },
  });

  assert.equal(
    (summary["solver"] as Record<string, unknown>)["訂單狀態"] as string,
    "executed",
  );
  assert.equal(
    (
      (summary["來源鏈"] as Record<string, unknown>)["escrow狀態"] as Record<
        string,
        unknown
      >
    )["label"],
    "Deposited",
  );
  assert.equal(
    (
      (summary["Hyperlane"] as Record<string, unknown>)[
        "messageView"
      ] as Record<string, unknown>
    )["is_delivered"],
    true,
  );
});

test("buildTrackingSummaryData Hyperlane shows neutral status when no DispatchId", () => {
  const summary = buildTrackingSummaryData({
    orderId: "0x01",
    sourceChainName: "A",
    destinationChainName: "B",
    solverOrderResult: {
      ok: true,
      value: {
        status: "executed",
        updatedAt: 1,
        fillTransaction: {
          hash: "0x02",
          status: "executed",
          timestamp: 2,
        },
      },
    },
    sourceOrderStatusResult: {
      ok: true,
      value: { code: 1, label: "Deposited" },
    },
    finalisedLogResult: { ok: true, value: null },
    fillReceiptResult: {
      ok: true,
      value: { status: "success", blockNumber: 3n },
    },
    outputSettlerLogsResult: {
      ok: true,
      value: { blockNumber: "3", logCount: 0, topics: [] },
    },
    mailboxDispatchResult: { ok: true, value: null },
    hyperlaneResult: undefined,
  });
  const hyper = summary["Hyperlane"] as Record<string, unknown>;
  assert.equal(hyper["狀態"], "無 DispatchId");
  assert.ok(typeof hyper["說明"] === "string");
});

test("buildDoctorReportData renders Chinese fields and formatted allowances", () => {
  const report = buildDoctorReportData({
    route: "base-sepolia USDC -> sepolia EURC",
    quoteId: "quote-2",
    quoteSpender: "0x8429Ba4323b2131aA7FB1947E20dB479030c12c1",
    configuredSettlerFallback: "0x8429Ba4323b2131aA7FB1947E20dB479030c12c1",
    totalInputAmount: 5_000_000n,
    previewOutputAmount: "4900000",
    fromToken,
    toToken,
    orderPreview: buildOrderPreviewData({
      actionLabel: "open",
      sourceChainName: "Base Sepolia",
      destinationChainName: "Ethereum Sepolia",
      fromToken,
      toToken,
      receiver: "0x3333333333333333333333333333333333333333",
      standardOrder: sampleOrder,
      quoteId: "quote-2",
      quoteType: "oif-escrow-v0",
      quoteSpender: "0x8429Ba4323b2131aA7FB1947E20dB479030c12c1",
    }),
    balance: 10_000_000n,
    allowances: [
      {
        label: "報價提供的 Spender",
        address: "0x8429Ba4323b2131aA7FB1947E20dB479030c12c1",
        allowance: 5_000_000n,
        enough: true,
      },
    ],
    simulation: { ok: true },
    trackingSummary: {
      訂單識別: "0xabc",
      solver: { 訂單狀態: "created" },
    },
  });

  assert.equal(report["輸入數量"], "5 USDC");
  assert.equal(report["預估輸出數量"], "4.9 EURC");
  assert.equal(
    (report["使用者餘額"] as Record<string, unknown>)["formatted"],
    "10 USDC",
  );
  assert.equal(
    (report["Allowances"] as Array<Record<string, unknown>>)[0]["allowance"],
    "5 USDC",
  );
});
