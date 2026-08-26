import { describe, expect, test } from "bun:test";
import {
  parseVerificationKey,
  verificationKey,
  verificationKeyPrefix,
} from "../../packages/libs/verificationKey";

/**
 * `chatId:userId` 复合键的生成/解析/归属判定。
 *
 * 本文件是格式的唯一契约点：往返一致、负数群 id 不被负号误切、形状不符一律
 * null（调用方据此
 * 丢弃，绝不拿 NaN 继续投递）。
 */
describe("待验证复合键", () => {
  test("生成与解析往返一致，负数群 id 不被负号切错", () => {
    const key: string = verificationKey(-1_001_234_567_890, 42);
    expect(key).toBe("-1001234567890:42");
    expect(parseVerificationKey(key)).toEqual({ chatId: -1_001_234_567_890, userId: 42 });
  });

  test("前缀与生成方同源，能挑出本群条目且不误伤别的群", () => {
    const prefix: string = verificationKeyPrefix(-1001);
    expect(verificationKey(-1001, 7).startsWith(prefix)).toBeTrue();
    // -10010 与 -1001 的前缀只差一位，少了分隔符就会互相误伤。
    expect(verificationKey(-10_010, 7).startsWith(prefix)).toBeFalse();
  });

  test("形状不符一律 null，不交出 NaN", () => {
    expect(parseVerificationKey("nope")).toBeNull();
    expect(parseVerificationKey(":42")).toBeNull();
    expect(parseVerificationKey("-1001:")).toBeNull();
    expect(parseVerificationKey("-1001:abc")).toBeNull();
    // 超出安全整数范围的一侧同样按不可用处理。
    expect(parseVerificationKey("-1001:99999999999999999999")).toBeNull();
    // `Number("")` 是 0 且是安全整数：只查 isSafeInteger 会把这个键解成
    // userId=0 这么一个凭空捏造的目标，往返校验才拦得住。
    expect(parseVerificationKey("-1001: 42")).toBeNull();
    expect(parseVerificationKey("-1001:+42")).toBeNull();
    expect(parseVerificationKey("-1001:4e1")).toBeNull();
  });
});
