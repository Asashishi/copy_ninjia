import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  LUCK_RECEIPT_DISPLAY_PREFIX,
  LUCK_RECEIPT_MAX_LENGTH,
} from "../../src/consts/luckReceipt";
import {
  createLuckReceipt,
  deriveLuckEntropy,
  isLuckReceiptHash,
  luckReceiptHmacHash,
  stripLuckReceipt,
  luckReceiptHashFromLine,
  verifyLuckReceipt,
} from "../../src/libs/luckReceipt";
import type { LuckReceiptSecret } from "../../src/types";

const DAY = "2026-07-19";
const SECRET: LuckReceiptSecret = { version: 1, day: DAY, key: Buffer.alloc(32, 7).toString("base64url") };
const OTHER_SECRET: LuckReceiptSecret = { version: 1, day: DAY, key: Buffer.alloc(32, 8).toString("base64url") };

describe("luck receipt protocol", () => {
  test("自描述回执往返默认 key 与带文本摘要 key", () => {
    for (const cacheKey of ["123", `123:${"a".repeat(64)}`]) {
      const receipt: string = createLuckReceipt(SECRET, cacheKey);
      expect(receipt.startsWith(`luck:v1:${DAY}:`)).toBe(true);
      expect(receipt.length).toBeLessThanOrEqual(LUCK_RECEIPT_MAX_LENGTH);
      expect(verifyLuckReceipt(receipt, DAY, SECRET)).toBe(cacheKey);
    }
  });

  test("拒绝错误版本、错误日期、篡改签名、错误密钥和超长输入", () => {
    const receipt: string = createLuckReceipt(SECRET, "123");
    expect(verifyLuckReceipt(receipt.replace("luck:v1", "luck:v2"), DAY, SECRET)).toBeUndefined();
    expect(verifyLuckReceipt(receipt, "2026-07-20", { ...SECRET, day: "2026-07-20" })).toBeUndefined();
    expect(verifyLuckReceipt(`${receipt.slice(0, -1)}A`, DAY, SECRET)).toBeUndefined();
    expect(verifyLuckReceipt(receipt, DAY, OTHER_SECRET)).toBeUndefined();
    expect(verifyLuckReceipt("x".repeat(LUCK_RECEIPT_MAX_LENGTH + 1), DAY, SECRET)).toBeUndefined();
  });

  test("同一日期、密钥和 cache key 派生熵稳定，任一输入改变都会变化", () => {
    const first: Buffer = deriveLuckEntropy(SECRET, "123");
    expect(deriveLuckEntropy(SECRET, "123")).toEqual(first);
    expect(deriveLuckEntropy(SECRET, "124")).not.toEqual(first);
    expect(deriveLuckEntropy(OTHER_SECRET, "123")).not.toEqual(first);
  });

  test("展示值直接复用回执的 HMAC，不再对完整回执二次哈希", () => {
    const firstReceipt: string = createLuckReceipt(SECRET, "123");
    const unsigned: string = firstReceipt.slice(0, firstReceipt.lastIndexOf("."));
    const expectedHmac: string = createHmac("sha256", Buffer.from(SECRET.key, "base64url"))
      .update(unsigned, "utf8")
      .digest("hex");
    const first: string | undefined = luckReceiptHmacHash(firstReceipt);
    expect(first).toBe(expectedHmac);
    expect(first).toHaveLength(64);
    expect(isLuckReceiptHash(first!)).toBe(true);
    expect(luckReceiptHmacHash(createLuckReceipt(SECRET, "124"))).not.toBe(first);
    expect(luckReceiptHmacHash("not-a-receipt")).toBeUndefined();
    expect(isLuckReceiptHash(first!.toUpperCase())).toBe(false);
  });

  test("stripLuckReceipt 只移除末行的当前格式展示哈希", () => {
    const receipt: string = createLuckReceipt(SECRET, "123");
    const receiptHash: string = luckReceiptHmacHash(receipt)!;
    expect(stripLuckReceipt(`可读正文\n${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash}`)).toBe("可读正文");
    // 旧格式（无标签的完整协议串、或标签后跟完整协议串）不再被识别为回执。
    expect(stripLuckReceipt(`可读正文\n${receipt}`)).toBe(`可读正文\n${receipt}`);
    expect(stripLuckReceipt(`可读正文\n${LUCK_RECEIPT_DISPLAY_PREFIX}${receipt}`))
      .toBe(`可读正文\n${LUCK_RECEIPT_DISPLAY_PREFIX}${receipt}`);
    expect(stripLuckReceipt(`可读正文\n${receiptHash}`)).toBe(`可读正文\n${receiptHash}`);
    expect(stripLuckReceipt(`正文 ${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash}`))
      .toBe(`正文 ${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash}`);
    expect(stripLuckReceipt("普通正文\nluck:伪造")).toBe("普通正文\nluck:伪造");
  });

  test("luckReceiptHashFromLine 只认标签前缀加定长摘要", () => {
    const receipt: string = createLuckReceipt(SECRET, "123");
    const receiptHash: string = luckReceiptHmacHash(receipt)!;
    expect(luckReceiptHashFromLine(`${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash}`)).toBe(receiptHash);
    expect(luckReceiptHashFromLine(receiptHash)).toBeUndefined();
    expect(luckReceiptHashFromLine(receipt)).toBeUndefined();
    expect(luckReceiptHashFromLine(`${LUCK_RECEIPT_DISPLAY_PREFIX}${receipt}`)).toBeUndefined();
    expect(luckReceiptHashFromLine(`${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash.toUpperCase()}`)).toBeUndefined();
  });
});
