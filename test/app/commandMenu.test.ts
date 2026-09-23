import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GrammyError } from "grammy";
import type { Bot } from "grammy";
import { registerCommandMenu, syncChatCommandMenu } from "../../packages/app/commandMenu";
import { chatStateCache } from "../../packages/cache/main/chatState";
import { getOrCreateChatState } from "../../packages/infra/storage/stateStore";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { BOT_COMMANDS } from "../../packages/consts/atmosphere/teasing/commands";
import { logger } from "../../packages/infra/logger";

beforeEach(() => { chatStateCache.clear(); });

test("启动只把菜单注册到所有群聊并清掉默认作用域（私聊不显示菜单），再按群人设恢复普通菜单或删除旧的群菜单", async () => {
  getOrCreateChatState(-1001).aiPersona = "自定义";
  getOrCreateChatState(-1002).isInitEnabled = true;
  const setMyCommands = mock(async (..._args: unknown[]): Promise<true> => true);
  const deleteMyCommands = mock(async (..._args: unknown[]): Promise<true> => true);
  await registerCommandMenu({ api: { setMyCommands, deleteMyCommands } } as unknown as Bot);
  expect(setMyCommands.mock.calls[0]).toEqual([ATMOSPHERE_TEXTS.teasing.BOT_COMMANDS, { scope: { type: "all_group_chats" } }]);
  // 默认作用域在群作用域注册成功之后才清。
  expect(deleteMyCommands.mock.calls[0]).toEqual([]);
  expect(setMyCommands).toHaveBeenCalledWith(ATMOSPHERE_TEXTS.plain.BOT_COMMANDS, { scope: { type: "chat", chat_id: -1001 } });
  expect(deleteMyCommands).toHaveBeenCalledWith({ scope: { type: "chat", chat_id: -1002 } });
  expect(setMyCommands).toHaveBeenCalledTimes(2);
});

test("群聊菜单注册失败时不清默认作用域，只记一行日志", async () => {
  const setMyCommands = mock(async (..._args: unknown[]): Promise<true> => { throw new Error("unavailable"); });
  const deleteMyCommands = mock(async (..._args: unknown[]): Promise<true> => true);
  const error = spyOn(logger, "error").mockImplementation(() => undefined);
  try {
    await registerCommandMenu({ api: { setMyCommands, deleteMyCommands } } as unknown as Bot);
    expect(deleteMyCommands).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  } finally { error.mockRestore(); }
});

test("人设变更只操作目标群作用域，移除后回落到所有群聊的菜单", async () => {
  const setMyCommands = mock(async (..._args: unknown[]): Promise<true> => true);
  const deleteMyCommands = mock(async (..._args: unknown[]): Promise<true> => true);
  const api = { setMyCommands, deleteMyCommands };
  const state = getOrCreateChatState(-1001);
  state.aiPersona = "自定义";
  await syncChatCommandMenu(api, -1001);
  state.aiPersona = undefined;
  await syncChatCommandMenu(api, -1001);
  expect(setMyCommands.mock.calls).toEqual([[ATMOSPHERE_TEXTS.plain.BOT_COMMANDS, { scope: { type: "chat", chat_id: -1001 } }]]);
  expect(deleteMyCommands.mock.calls).toEqual([[{ scope: { type: "chat", chat_id: -1001 } }]]);
});

test("某群菜单更新失败仍继续同步其他群", async () => {
  getOrCreateChatState(-1001).aiPersona = "第一群";
  getOrCreateChatState(-1002).aiPersona = "第二群";
  const setMyCommands = mock(async (..._args: unknown[]): Promise<true> => true);
  setMyCommands.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("unavailable"));
  const deleteMyCommands = mock(async (..._args: unknown[]): Promise<true> => true);
  const error = spyOn(logger, "error").mockImplementation(() => undefined);
  try {
    await registerCommandMenu({ api: { setMyCommands, deleteMyCommands } } as unknown as Bot);
    expect(setMyCommands).toHaveBeenLastCalledWith(ATMOSPHERE_TEXTS.plain.BOT_COMMANDS, { scope: { type: "chat", chat_id: -1002 } });
    expect(error).toHaveBeenCalledTimes(1);
  } finally { error.mockRestore(); }
});

test("机器人已不在的群菜单同步遇 403 只记 warn，其它失败仍记 error", async () => {
  const api = {
    setMyCommands: mock(async (..._args: unknown[]): Promise<true> => true),
    deleteMyCommands: mock(async (..._args: unknown[]): Promise<true> => {
      throw new GrammyError(
        "x",
        { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the group chat" },
        "deleteMyCommands",
        {}
      );
    }),
  };
  const error = spyOn(logger, "error").mockImplementation(() => undefined);
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    await syncChatCommandMenu(api, -1001);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Skipped the commands menu for chat -1001: the bot is no longer in the chat (Forbidden: bot was kicked from the group chat)."
    );
  } finally {
    error.mockRestore();
    warn.mockRestore();
  }
});

describe("application command menu", () => {
  test("copy、qa、mood、icon 只展示统一入口并说明子命令", () => {
    const names: readonly string[] = BOT_COMMANDS.map(({ command }) => command);
    for (const command of ["copy", "qa", "mood", "icon"]) expect(names).toContain(command);
    for (const command of ["r_copy", "nya_copy", "stop_copy", "set_qa", "query_qa", "remove_qa", "query_mood", "switch_mood", "steal_icon", "reset_icon"]) {
      expect(names).not.toContain(command);
    }
    for (const [command, parameters] of [
      ["copy", ["reverse", "nya", "stop"]],
      ["qa", ["set", "query", "remove", "isCanControllQaPermission"]],
      ["mood", ["query", "switch"]],
      ["icon", ["steal", "reset"]],
    ] as const) {
      const description: string | undefined = BOT_COMMANDS.find((entry) => entry.command === command)?.description;
      for (const parameter of parameters) expect(description).toContain(parameter);
    }
  });

  test("命令名全部满足 Telegram 的字符集与长度限制", () => {
    // setMyCommands 整体提交：任一命令非法会让整份菜单以 BOT_COMMAND_INVALID 失败。
    for (const { command, description } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(256);
      expect(description).toEndWith("♡");
      expect(description).toMatch(/本天才|杂鱼|笨蛋/);
    }
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("x");
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("white");
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("batch_kick");
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("mood");
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("flood_control");
    expect(BOT_COMMANDS.map(({ command }) => command)).toContain("bot_status");
    const permissionDescription: string | undefined =
      BOT_COMMANDS.find(({ command }) => command === "permission")?.description;
    expect(permissionDescription).toContain("所有杂鱼都能用");
    expect(permissionDescription).toContain("超级管理员");
    expect(permissionDescription).not.toContain("白名单边界内");
    const blockDescription: string | undefined =
      BOT_COMMANDS.find(({ command }) => command === "block")?.description;
    expect(blockDescription).toContain("isCanBlock");
    expect(blockDescription).toContain("isCanUnBlock");
    expect(BOT_COMMANDS.map(({ command }) => command)).not.toContain("unblock");
    expect(BOT_COMMANDS.find(({ command }) => command === "mute")?.description)
      .toContain("isCanMute");
    expect(BOT_COMMANDS.find(({ command }) => command === "unmute")?.description)
      .toContain("isCanUnMute");
    expect(BOT_COMMANDS.find(({ command }) => command === "init")?.description)
      .toContain("超级管理员");
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
