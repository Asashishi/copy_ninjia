import { describe, expect, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { atmosphereOf } from "../../packages/libs/atmosphere";
import { chatStateOf } from "../helpers/chatState";

describe("群通知文案风格", () => {
  test("没有自定义人设用雌小鬼文案，配置了人设用普通文案", () => {
    expect(atmosphereOf(chatStateOf(), "teasing")).toBe(ATMOSPHERE_TEXTS.teasing);
    expect(atmosphereOf(chatStateOf({ aiPersona: undefined }), "teasing")).toBe(ATMOSPHERE_TEXTS.teasing);
    expect(atmosphereOf(chatStateOf({ aiPersona: "温柔的助手" }), "teasing")).toBe(ATMOSPHERE_TEXTS.plain);
  });
});

test("Bot 普通风格在有无人设时均复用普通文案", () => {
  expect(atmosphereOf(chatStateOf(), "plain")).toBe(ATMOSPHERE_TEXTS.plain);
  expect(atmosphereOf(chatStateOf({ aiPersona: "自定义" }), "plain")).toBe(ATMOSPHERE_TEXTS.plain);
});
