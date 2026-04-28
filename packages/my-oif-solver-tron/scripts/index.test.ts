import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeOrderStatus,
  normalizePrivateKey,
  normalizeTronHex41,
  toInteropAddress,
  tron41HexToEvmHex,
  tronBase58ToHex,
  tronHexToBase58,
} from "./index.js";

test("tron-address converts base58 to hex and evm", () => {
  const tronHex41 = tronBase58ToHex("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.equal(tronHex41, "41A614F803B6FD780986A42C78EC9C7F77E6DED13C");
  assert.equal(
    tron41HexToEvmHex(tronHex41),
    "0xA614F803B6FD780986A42C78EC9C7F77E6DED13C",
  );
});

test("tron-address converts hex to base58", () => {
  assert.equal(
    tronHexToBase58("41A614F803B6FD780986A42C78EC9C7F77E6DED13C"),
    "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  );
});

test("tron-address roundtrip supports shasta USDT sample", () => {
  const input = "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs";
  const hex41 = tronBase58ToHex(input);
  assert.equal(tronHexToBase58(hex41), input);
  assert.equal(
    tron41HexToEvmHex(hex41),
    "0x42A1E39AEFA49290F2B3F9ED688D7CECF86CD6E0",
  );
});

test("tron-address rejects invalid 41-prefixed hex", () => {
  assert.throws(
    () => normalizeTronHex41("0x1234"),
    /TRON HEX 位址必須是 42 hex chars/,
  );
});

test("interop-address creates expected tron and hyperevm prefixes", () => {
  assert.equal(
    toInteropAddress(2494104990, "0x42A1E39AEFA49290F2B3F9ED688D7CECF86CD6E0"),
    "0x000100000494a9059e1442a1e39aefa49290f2b3f9ed688d7cecf86cd6e0",
  );
  assert.equal(
    toInteropAddress(998, "0x2B3370eE501B4a559b57D449569354196457D8Ab"),
    "0x000100000203e6142b3370ee501b4a559b57d449569354196457d8ab",
  );
});

test("normalize-private-key adds prefix and validates length", () => {
  assert.equal(
    normalizePrivateKey(
      "cd44d3887c5b268dc57c887253777075d325ef3b9c0eda9a05ee07d621747611",
    ),
    "0xcd44d3887c5b268dc57c887253777075d325ef3b9c0eda9a05ee07d621747611",
  );
  assert.throws(() => normalizePrivateKey("0x1234"), /格式錯誤/);
});

test("normalize-order-status supports string and failed object", () => {
  assert.equal(normalizeOrderStatus("Executed"), "executed");
  assert.equal(normalizeOrderStatus({ failed: ["Fill", "error"] }), "failed");
  assert.equal(normalizeOrderStatus({ unknown: true }), "unknown");
});
