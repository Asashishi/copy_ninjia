import { describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { Context, RawApi, Transformer } from "grammy";
import type { MessageEntity, Update } from "grammy/types";
import { registerHandlers } from "../../packages/app/registerHandlers";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { SUPER_ADMIN_USER_ID } from "../../packages/config/bot";
import { installTelegramApi } from "../../packages/infra/telegram/client";
import { bot as mainBot } from "../../packages/infra/telegram/mainClient";
import type { TelegramApi } from "../../packages/types/telegramWorker";

/**
 * 私聊里除超级管理员的 `/send` 以外，任何命令都不得换来一条回复：用真实 grammY Bot 与
 * 真实 registerHandlers 灌入私聊更新，出站请求一律截下计数。菜单里的每一条命令、
 * 不在菜单里的子命令、中文动作命令与 caption 形态逐条覆盖，普通用户与超管各跑一遍。
 */

const USER_ID: number = SUPER_ADMIN_USER_ID + 1;

/** 两套菜单的全部命令，加上不在菜单里的写法。 */
function privateCommandTexts(): readonly string[] {
  const texts: Set<string> = new Set<string>();
  for (const commands of [ATMOSPHERE_TEXTS.teasing.BOT_COMMANDS, ATMOSPHERE_TEXTS.plain.BOT_COMMANDS]) {
    for (const { command } of commands) {
      texts.add(`/${command}`);
      texts.add(`/${command}@test_bot`);
    }
  }
  for (const extra of ["/info 42", "/info @someone", "/h_image add", "/bot_status", "/start", "/send -100123"]) texts.add(extra);
  return [...texts];
}

function commandEntity(text: string): MessageEntity[] {
  const length: number = text.split(" ", 1)[0]!.length;
  return [{ type: "bot_command", offset: 0, length }];
}

/**
 * 所有出站请求只记录方法名，不联网。handler 经模块级主线程客户端发送（mainClient 的 bot），
 * 分派用的测试 Bot 也可能直接调用自己的 api，两处都截下。
 */
const calls: string[] = [];
const recordCall: Transformer<RawApi> = async (_previous, method) => {
  calls.push(method);
  return { ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } } as never;
};
mainBot.api.config.use(recordCall);
// handler 经本线程安装的能力面发送（infra/telegram/client.ts）；换成只记录方法名的替身。
installTelegramApi(new Proxy({}, {
  get: (_target: object, method: string | symbol): unknown => async (): Promise<unknown> => {
    calls.push(String(method));
    return { message_id: 1, date: 1, chat: { id: 1, type: "private" } };
  },
}) as TelegramApi);

/** 装好 handler 的真实 Bot。 */
function createBot(): { bot: Bot<Context>; calls: string[] } {
  const bot: Bot<Context> = new Bot<Context>("123456:TEST", {
    botInfo: {
      id: 999, is_bot: true, first_name: "Bot", username: "test_bot",
      can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: true,
    } as never,
  });
  bot.api.config.use(recordCall);
  registerHandlers(bot as never);
  calls.length = 0;
  return { bot, calls };
}

let updateId: number = 1;

function privateUpdate(senderId: number, fields: Record<string, unknown>): Update {
  const id: number = updateId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      chat: { id: senderId, type: "private", first_name: "User" },
      from: { id: senderId, is_bot: false, first_name: "User" },
      ...fields,
    },
  } as unknown as Update;
}

describe("私聊命令一律不回复（超级管理员的 /send 除外）", () => {
  test.each([
    ["普通用户", USER_ID],
    ["超级管理员", SUPER_ADMIN_USER_ID],
  ] as const)("%s发出的全部命令都不产生出站请求", async (_label: string, senderId: number) => {
    const { bot, calls } = createBot();
    for (const text of privateCommandTexts()) {
      // 超管的 /send 是唯一放行的命令，另有专门的测试。
      if (senderId === SUPER_ADMIN_USER_ID && text.startsWith("/send")) continue;
      await bot.handleUpdate(privateUpdate(senderId, { text, entities: commandEntity(text) }));
    }
    await bot.handleUpdate(privateUpdate(senderId, { text: "/咬 @someone" }));
    await bot.handleUpdate(privateUpdate(senderId, {
      photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
      caption: "/bot_status",
      caption_entities: [{ type: "bot_command", offset: 0, length: 11 }],
    }));
    expect(calls).toEqual([]);
  });

  test("对照：超级管理员的 /send 照常处理并回复，截获确实生效", async () => {
    const { bot, calls } = createBot();
    await bot.handleUpdate(privateUpdate(SUPER_ADMIN_USER_ID, { text: "/send finish", entities: commandEntity("/send finish") }));
    expect(calls).toContain("sendMessage");
  });
});
