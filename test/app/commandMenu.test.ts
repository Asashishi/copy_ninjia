import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Bot } from "grammy";
import { registerCommandMenu } from "../../packages/app/commandMenu";
import { BOT_COMMANDS } from "../../packages/consts/commands";
import { logger } from "../../packages/infra/logger";

describe("application command menu", () => {
  test("命令名全部满足 Telegram 的字符集与长度限制", () => {
    // setMyCommands 是整体提交：任何一项非法都会让整份菜单以
    // BOT_COMMAND_INVALID 失败，而注册失败只记日志、不阻断启动，
    // 于是菜单会静默消失。中文动作命令因此只能靠 /x 占位说明项曝光。
    for (const { command, description } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(256);
    }
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("x");
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("white");
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("batch_kick");
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("query_mood");
  });

  test("显式注册公开命令且不暴露管理员私聊 /send", async () => {
    const setMyCommands = mock(async (_commands: readonly { command: string; description: string }[]): Promise<true> => true);
    const bot = { api: { setMyCommands } } as unknown as Bot;

    await registerCommandMenu(bot);

    expect(setMyCommands).toHaveBeenCalledTimes(1);
    const commands = setMyCommands.mock.calls[0]![0] as readonly { command: string }[];
    expect(commands.map(({ command }) => command)).toContain("init");
    expect(commands.map(({ command }) => command)).not.toContain("send");
  });

  test("菜单注册失败只记录错误，不阻断启动", async () => {
    const failure = new Error("offline");
    const setMyCommands = mock(async (): Promise<never> => {
      throw failure;
    });
    const bot = { api: { setMyCommands } } as unknown as Bot;
    const error = spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(registerCommandMenu(bot)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("Failed to register bot commands menu:", failure);
    error.mockRestore();
  });
});
