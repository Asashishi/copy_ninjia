import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Bot } from "grammy";
import { registerCommandMenu } from "../../src/app/commandMenu";
import { logger } from "../../src/infra/logger";

describe("application command menu", () => {
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
