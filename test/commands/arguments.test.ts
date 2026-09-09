/**
 * 命令参数分词的唯一口径。空参数必须得到空数组而不是 `[""]`——四条命令都按
 * `tokens.length` / `tokens.at(-1)` 分派子命令，多出一个空 token 会让本该报用法的
 * 输入走进解析分支。
 */

import { describe, expect, test } from "bun:test";
import { commandArgumentTokens } from "../../packages/commands/arguments";

describe("commandArgumentTokens", (): void => {
  test("空参数与纯空白都得到空数组", (): void => {
    expect(commandArgumentTokens("")).toEqual([]);
    expect(commandArgumentTokens("   ")).toEqual([]);
    expect(commandArgumentTokens("\n\t ")).toEqual([]);
  });

  test("首尾空白与连续空白都不产生空 token", (): void => {
    expect(commandArgumentTokens("  @someone   1d  ")).toEqual(["@someone", "1d"]);
  });

  test("换行与制表同样算分隔符，相对顺序不变", (): void => {
    expect(commandArgumentTokens("query\t-1001234567890\nisCanBlock")).toEqual([
      "query",
      "-1001234567890",
      "isCanBlock",
    ]);
  });

  test("单个 token 原样返回", (): void => {
    expect(commandArgumentTokens("30m")).toEqual(["30m"]);
  });
});
