import { describe, expect, test } from "bun:test";
import {
  LUCK_RECEIPT_DISPLAY_PREFIX,
  LUCK_RECEIPT_MAX_LENGTH,
} from "../../src/consts/luckReceipt";
import {
  createLuckReceipt,
  deriveLuckEntropy,
  hashLuckReceipt,
  isLuckReceiptHash,
  stripLuckReceipt,
  unwrapLuckReceiptLine,
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

  test("展示用 SHA-256 固定为 64 位十六进制，且完整回执变化时随之变化", () => {
    const first: string = hashLuckReceipt(createLuckReceipt(SECRET, "123"));
    expect(first).toHaveLength(64);
    expect(isLuckReceiptHash(first)).toBe(true);
    expect(hashLuckReceipt(createLuckReceipt(SECRET, "124"))).not.toBe(first);
    expect(isLuckReceiptHash(first.toUpperCase())).toBe(false);
  });

  test("stripLuckReceipt 只移除末行的展示哈希或旧版自描述回执", () => {
    const receipt: string = createLuckReceipt(SECRET, "123");
    const receiptHash: string = hashLuckReceipt(receipt);
    expect(stripLuckReceipt(`可读正文\n${receipt}`)).toBe("可读正文");
    expect(stripLuckReceipt(`可读正文\n${LUCK_RECEIPT_DISPLAY_PREFIX}${receipt}`)).toBe("可读正文");
    expect(stripLuckReceipt(`可读正文\n${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash}`)).toBe("可读正文");
    expect(stripLuckReceipt(`可读正文\n${receiptHash}`)).toBe(`可读正文\n${receiptHash}`);
    expect(unwrapLuckReceiptLine(`${LUCK_RECEIPT_DISPLAY_PREFIX}${receipt}`)).toBe(receipt);
    expect(unwrapLuckReceiptLine(receipt)).toBe(receipt);
    expect(stripLuckReceipt(`正文 ${receipt}`)).toBe(`正文 ${receipt}`);
    expect(stripLuckReceipt("普通正文\nluck:伪造")).toBe("普通正文\nluck:伪造");
  });
});
