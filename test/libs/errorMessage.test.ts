import { describe, expect, test } from "bun:test";
import { errorMessage, toError, toErrorOr } from "../../packages/libs/errorMessage";

describe("catch 值归一化", () => {
  test("errorMessage 取 Error 的 message，其余值走 String()", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("text")).toBe("text");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  test("toError 原样保留 Error，其余值以字符串形式重建", () => {
    const original: Error = new TypeError("typed");
    expect(toError(original)).toBe(original);
    const rebuilt: Error = toError(42);
    expect(rebuilt).toBeInstanceOf(Error);
    expect(rebuilt.message).toBe("42");
  });

  test("toErrorOr 原样保留 Error；其余值用固定兜底文案并把原值挂进 cause", () => {
    const original: Error = new RangeError("range");
    expect(toErrorOr(original, "fallback")).toBe(original);
    for (const value of ["secret", 0, null, undefined, { code: 1 }]) {
      const normalized: Error = toErrorOr(value, "Fixed fallback.");
      expect(normalized).toBeInstanceOf(Error);
      expect(normalized.message).toBe("Fixed fallback.");
      expect(normalized.cause).toBe(value);
    }
  });
});
