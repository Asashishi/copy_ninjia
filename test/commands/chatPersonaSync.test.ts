/**
 * 群人设三处对外表现的同步边界（packages/commands/chatPersonaSync.ts）。
 *
 * 这一组从前在 botAdmin、`/prompt`、`/init disable` 三处逐字重复，顺序一旦分叉
 * 就会出现「命令菜单已经换了、Worker 还在用旧人设」这类只在群里才看得出来的
 * 不一致，因此顺序本身是契约。
 */

import { beforeEach, expect, mock, test } from "bun:test";
import type { Api } from "grammy";

const calls: string[] = [];
const syncAiChatPersona = mock((chatId: number): void => { calls.push(`aiChat:${chatId}`); });
const syncAntiRaidAtmosphere = mock((chatId: number): void => { calls.push(`antiRaid:${chatId}`); });
const syncChatCommandMenu = mock(async (_api: Api, chatId: number): Promise<void> => {
  calls.push(`menu:${chatId}`);
});

mock.module("../../packages/aiChat/workerBridge", () => ({ syncAiChatPersona }));
mock.module("../../packages/antiRaid/workerBridge/controller", () => ({ syncAntiRaidAtmosphere }));
mock.module("../../packages/app/commandMenu", () => ({ syncChatCommandMenu }));

const { syncChatPersonaSurfaces } =
  await import("../../packages/commands/chatPersonaSync");

const API: Api = { kind: "test-api" } as never;
const CHAT_ID: number = -1_001;

beforeEach((): void => {
  calls.length = 0;
  syncAiChatPersona.mockClear();
  syncAntiRaidAtmosphere.mockClear();
  syncChatCommandMenu.mockClear();
  syncChatCommandMenu.mockImplementation(async (_api: Api, chatId: number): Promise<void> => {
    calls.push(`menu:${chatId}`);
  });
});

test("两个 Worker 快照先就位，命令菜单最后发", async () => {
  await syncChatPersonaSurfaces(API, CHAT_ID);

  expect(calls).toEqual([`aiChat:${CHAT_ID}`, `antiRaid:${CHAT_ID}`, `menu:${CHAT_ID}`]);
  expect(syncChatCommandMenu).toHaveBeenCalledWith(API, CHAT_ID);
});

test("命令菜单是唯一的真实出站请求，它的失败原样上抛", async () => {
  syncChatCommandMenu.mockImplementation(async (): Promise<never> => {
    throw new Error("setMyCommands failed");
  });

  await expect(syncChatPersonaSurfaces(API, CHAT_ID)).rejects.toThrow("setMyCommands failed");
  // 失败在最后一步，两个 Worker 快照已经落到新人设上。
  expect(calls).toEqual([`aiChat:${CHAT_ID}`, `antiRaid:${CHAT_ID}`]);
});
