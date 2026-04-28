import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTronHex41,
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
