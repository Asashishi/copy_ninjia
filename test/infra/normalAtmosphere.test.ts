import { afterEach, expect, mock, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { defaultAtmosphereState as aiAtmosphere, resetAiChatIdentityCache } from "../../packages/cache/workers/aiChat/identity";
import { defaultAtmosphereState as raidAtmosphere, plainAtmosphereChats } from "../../packages/cache/workers/antiRaid/atmosphere";
import { chatPersonas } from "../../packages/cache/workers/aiChat/persona";
import { aiChatAtmosphere } from "../../packages/workers/aiChat/atmosphere";
import { workerAtmosphere } from "../../packages/workers/antiRaid/atmosphere";
import type { Atmosphere } from "../../packages/types/atmosphere";
import type { ChatState } from "../../packages/types/chatState";
import type { Context } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import type * as BotModule from "../../packages/config/bot";
import type * as StateStoreModule from "../../packages/infra/storage/stateStore";
import { LUCK_TIERS, RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../packages/consts/luckChallenge";
import { getTokyoDateKey } from "../../packages/libs/time";
import { dailyLuckCache, luckCacheState, luckReceiptSecretState, recentCallTimestamps } from "../../packages/cache/main/luckChallenge";

const config: typeof BotModule = { ...await import("../../packages/config/bot") };
mock.module("../../packages/config/bot", () => ({ ...config, BOT_ATMOSPHERE: "plain" }));
const stateStore: typeof StateStoreModule = { ...await import("../../packages/infra/storage/stateStore") };
const states = new Map<number, ChatState>([[-1, { aiPersona: "custom" }], [-2, {}]]);
mock.module("../../packages/infra/storage/stateStore", () => ({
  ...stateStore,
  getChatState: (id: number): ChatState => states.get(id) ?? {},
  getChatStateCache: (): ReadonlyMap<number, ChatState> => states,
}));
const { chatAtmosphere } = await import("../../packages/infra/atmosphere");
const { registerCommandMenu, syncChatCommandMenu } = await import("../../packages/app/commandMenu");
const { handleLuckChallengeInlineQuery } = await import("../../packages/commands/luckChallenge/telegramAdapter");

afterEach(() => {
  resetAiChatIdentityCache();
  raidAtmosphere.current = null;
  plainAtmosphereChats.clear();
  chatPersonas.clear();
  dailyLuckCache.clear();
  luckCacheState.dayKey = "";
  luckReceiptSecretState.current = null;
  recentCallTimestamps.clear();
});

test("inline 运势的称呼、评语和限频提示使用 Bot 普通语气", async (): Promise<void> => {
  const day: string = getTokyoDateKey();
  luckCacheState.dayKey = day;
  luckReceiptSecretState.current = {
    version: 1,
    day,
    key: new Uint8Array(32).fill(7).toBase64({ alphabet: "base64url", omitPadding: true }),
  };
  dailyLuckCache.set("101", { tier: LUCK_TIERS[0]!, fortunePercent: 90 });
  const results: InlineQueryResultArticle[] = [];
  const ctx: Context = {
    inlineQuery: { from: { id: 101, first_name: "" }, query: "" },
    answerInlineQuery: async (articles: InlineQueryResultArticle[]): Promise<void> => { results.push(...articles); },
  } as unknown as Context;
  await handleLuckChallengeInlineQuery(ctx);
  expect(results).toHaveLength(2);
  const content: InlineQueryResultArticle["input_message_content"] = results[0]!.input_message_content;
  expect(content).toHaveProperty("message_text", expect.stringContaining(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.unknownUser));
  expect(content).toHaveProperty("message_text", expect.stringContaining(ATMOSPHERE_TEXTS.plain.LUCK_TIER_COMMENTS.大吉));
  for (let index: number = 1; index < RATE_LIMIT_MAX_CALLS_PER_WINDOW; index++) recentCallTimestamps.push(Date.now());
  results.length = 0;
  await handleLuckChallengeInlineQuery(ctx);
  expect(results).toHaveLength(1);
  expect(results[0]!.title).toBe(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.inlineRateLimitTitle);
});

test("普通风格下主线程与群菜单一致，人设移除后回落到全群普通菜单", async () => {
  expect(chatAtmosphere(-1)).toBe(ATMOSPHERE_TEXTS.plain);
  expect(chatAtmosphere(-2)).toBe(ATMOSPHERE_TEXTS.plain);
  const setMyCommands = mock(async (): Promise<true> => true);
  const deleteMyCommands = mock(async (): Promise<true> => true);
  const api = { setMyCommands, deleteMyCommands };
  await registerCommandMenu({ api } as never);
  expect(setMyCommands).toHaveBeenCalledWith(ATMOSPHERE_TEXTS.plain.BOT_COMMANDS, { scope: { type: "all_group_chats" } });
  await syncChatCommandMenu(api, -2);
  expect(deleteMyCommands).toHaveBeenLastCalledWith({ scope: { type: "chat", chat_id: -2 } });
});

test("两个 Worker 读取初始化默认风格，自定义人设仍优先普通文案", () => {
  for (const style of ["teasing", "plain"] as readonly Atmosphere[]) {
    aiAtmosphere.current = style;
    raidAtmosphere.current = style;
    chatPersonas.set(-1, "custom");
    plainAtmosphereChats.add(-1);
    expect(aiChatAtmosphere(-1)).toBe(ATMOSPHERE_TEXTS.plain);
    expect(workerAtmosphere(-1)).toBe(ATMOSPHERE_TEXTS.plain);
    expect(aiChatAtmosphere(-2)).toBe(ATMOSPHERE_TEXTS[style]);
    expect(workerAtmosphere(-2)).toBe(ATMOSPHERE_TEXTS[style]);
    chatPersonas.delete(-1);
    plainAtmosphereChats.delete(-1);
    expect(aiChatAtmosphere(-1)).toBe(ATMOSPHERE_TEXTS[style]);
    expect(workerAtmosphere(-1)).toBe(ATMOSPHERE_TEXTS[style]);
  }
});
