import { beforeEach, expect, mock, test } from "bun:test";
import type { ChatState } from "../../packages/types/chatState";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";

const states: Map<number, ChatState> = new Map<number, ChatState>();
const empty: Readonly<ChatState> = {};
const readState = mock((chatId: number): Readonly<ChatState> => states.get(chatId) ?? empty);
mock.module("../../packages/infra/storage/stateStore", () => ({ getChatState: readState }));
const { chatAtmosphere } = await import("../../packages/infra/atmosphere");

beforeEach(() => { states.clear(); readState.mockClear(); });

test("群人设配置决定语气，AI 开关不改变选择，读取复用常量表", () => {
  states.set(-1001, { aiPersona: "温和回答", isAIChatEnabled: false });
  states.set(-1002, { isAIChatEnabled: true });
  expect(chatAtmosphere(-1001)).toBe(ATMOSPHERE_TEXTS.plain);
  expect(chatAtmosphere(-1001)).toBe(ATMOSPHERE_TEXTS.plain);
  expect(chatAtmosphere(-1002)).toBe(ATMOSPHERE_TEXTS.teasing);
  expect(chatAtmosphere(-1003)).toBe(ATMOSPHERE_TEXTS.teasing);
  expect(readState).toHaveBeenCalledTimes(4);
  expect(states.size).toBe(2);
});

test("人设修改和群状态删除即时切换，不保留另一份主线程风格缓存", () => {
  const state: ChatState = { aiPersona: "自定义" };
  states.set(-1001, state);
  expect(chatAtmosphere(-1001)).toBe(ATMOSPHERE_TEXTS.plain);
  state.aiPersona = undefined;
  expect(chatAtmosphere(-1001)).toBe(ATMOSPHERE_TEXTS.teasing);
  state.aiPersona = "另一个人设";
  expect(chatAtmosphere(-1001)).toBe(ATMOSPHERE_TEXTS.plain);
  states.delete(-1001);
  expect(chatAtmosphere(-1001)).toBe(ATMOSPHERE_TEXTS.teasing);
});
