import { describe, expect, test } from "bun:test";
import { parseChatIdArgument, parseUserIdArgument } from "../../packages/libs/telegramId";

describe("Telegram ID 参数解析", () => {
  test("用户 ID 只认规范十进制正安全整数", () => {
    expect(parseUserIdArgument("7")).toBe(7);
    expect(parseUserIdArgument("9007199254740991")).toBe(9_007_199_254_740_991);
    for (const raw of ["", "0", "07", "+7", "-7", " 7", "7 ", "7.0", "1e3", "0x10", "9007199254740992", "@alice"]) {
      expect(parseUserIdArgument(raw)).toBeUndefined();
    }
  });

  test("会话 ID 只认规范十进制负安全整数", () => {
    expect(parseChatIdArgument("-1001")).toBe(-1001);
    expect(parseChatIdArgument("-9007199254740991")).toBe(-9_007_199_254_740_991);
    for (const raw of ["", "-0", "-01001", "1001", "--1001", " -1001", "-1001.0", "-1e3", "-9007199254740992"]) {
      expect(parseChatIdArgument(raw)).toBeUndefined();
    }
  });
});
