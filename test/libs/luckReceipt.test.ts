import { describe, expect, test } from "bun:test";
import {
  LUCK_RECEIPT_DISPLAY_PREFIX,
  LUCK_RECEIPT_MAX_LENGTH,
} from "../../packages/consts/luckReceipt";
import {
  createLuckReceipt,
  deriveLuckEntropy,
  isLuckReceiptHash,
  luckReceiptHmacHash,
  stripLuckReceipt,
  luckReceiptHashFromLine,
  verifyLuckReceipt,
} from "../../packages/libs/luckReceipt";
import type { LuckReceiptSecret } from "../../packages/types";

const DAY = "2026-07-19";
const SECRET: LuckReceiptSecret = { version: 1, day: DAY, key: Buffer.alloc(32, 7).toString("base64url") };
const OTHER_SECRET: LuckReceiptSecret = { version: 1, day: DAY, key: Buffer.alloc(32, 8).toString("base64url") };
const EXPECTED_123_HMAC: string =
  "916338242888c03e98e3d6efaaaba002b26adffee09afeb8bd963cd67102fb5a";

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

  test("解不开的 base64url 一律返回 undefined，不抛异常", () => {
    // LUCK_RECEIPT_PATTERN 的 cache key 组允许 1..120 个字符，其中长度
    // ≡ 1 (mod 4) 的取值不是合法 base64url。这些回执来自群消息实体，异常逸出
    // 会被 bot.catch 重抛成整进程重启循环，因此必须当成普通的格式不合法。
    const signaturePart: string = createLuckReceipt(SECRET, "123").split(".")[1]!;
    for (const length of [1, 5, 9, 117]) {
      const receipt: string = `luck:v1:${DAY}:${"A".repeat(length)}.${signaturePart}`;
      expect(() => verifyLuckReceipt(receipt, DAY, SECRET)).not.toThrow();
      expect(verifyLuckReceipt(receipt, DAY, SECRET)).toBeUndefined();
      expect(() => luckReceiptHmacHash(receipt)).not.toThrow();
    }
    // 签名组定长 43，本身永远解得开；非规范尾比特由回环比较挡下。
    const nonCanonical: string = `luck:v1:${DAY}:MTIz.${"B".repeat(43)}`;
    expect(luckReceiptHmacHash(nonCanonical)).toBeUndefined();
    expect(verifyLuckReceipt(nonCanonical, DAY, SECRET)).toBeUndefined();
  });

  test("同一日期、密钥和 cache key 派生熵稳定，任一输入改变都会变化", () => {
    const first: Uint8Array = deriveLuckEntropy(SECRET, "123");
    expect(deriveLuckEntropy(SECRET, "123")).toEqual(first);
    expect(deriveLuckEntropy(SECRET, "124")).not.toEqual(first);
    expect(deriveLuckEntropy(OTHER_SECRET, "123")).not.toEqual(first);
  });

  test("展示值直接复用回执的 HMAC，不再对完整回执二次哈希", () => {
    const firstReceipt: string = createLuckReceipt(SECRET, "123");
    const first: string | undefined = luckReceiptHmacHash(firstReceipt);
    expect(first).toBe(EXPECTED_123_HMAC);
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
    expect(luckReceiptHashFromLine(`${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash}`, 0)).toBe(receiptHash);
    expect(luckReceiptHashFromLine(receiptHash, 0)).toBeUndefined();
    expect(luckReceiptHashFromLine(receipt, 0)).toBeUndefined();
    expect(luckReceiptHashFromLine(`${LUCK_RECEIPT_DISPLAY_PREFIX}${receipt}`, 0)).toBeUndefined();
    expect(luckReceiptHashFromLine(`${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash.toUpperCase()}`, 0)).toBeUndefined();
    expect(luckReceiptHashFromLine("", 0)).toBeUndefined();
  });

  test("luckReceiptHashFromLine 按末行偏移读原串，与先切末行逐字等价", () => {
    const receipt: string = createLuckReceipt(SECRET, "123");
    const receiptHash: string = luckReceiptHmacHash(receipt)!;
    const bodies: readonly string[] = [
      "运势正文",
      "多行\n正文",
      "带前缀的伪装行\n不是回执",
      "",
    ];
    const lastLines: readonly string[] = [
      `${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash}`,
      `${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash.slice(0, 63)}`,
      receiptHash,
      "",
      "普通末行",
    ];
    for (const body of bodies) {
      for (const lastLine of lastLines) {
        const text: string = `${body}\n${lastLine}`;
        const lastLineStart: number = text.lastIndexOf("\n") + 1;
        // 参考实现：先把末行切出来再判，等价性由这条对拍守住。
        const reference: string | undefined = text.slice(lastLineStart)
          .startsWith(LUCK_RECEIPT_DISPLAY_PREFIX)
          ? text.slice(lastLineStart + LUCK_RECEIPT_DISPLAY_PREFIX.length)
          : undefined;
        const expected: string | undefined =
          reference !== undefined && /^[a-f0-9]{64}$/.test(reference) ? reference : undefined;
        expect(luckReceiptHashFromLine(text, lastLineStart)).toBe(expected);
      }
    }
  });
});
