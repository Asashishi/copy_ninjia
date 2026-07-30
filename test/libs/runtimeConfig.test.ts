import { describe, expect, test } from "bun:test";
import { parseTelegramUserId } from "../../packages/libs/runtimeConfig";

describe("runtime config validation", () => {
  test("only accepts positive decimal safe Telegram user IDs", () => {
    expect(parseTelegramUserId("123", "TEST")).toBe(123);
    for (const raw of ["0", "-1", "1.5", "1e3", " 1", "9007199254740992"]) {
      expect(() => parseTelegramUserId(raw, "TEST")).toThrow("Invalid Telegram user ID");
    }
  });
});
