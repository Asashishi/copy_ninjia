import { describe, expect, test } from "bun:test";
import { hasExplicitImageGenerationIntent } from "../../src/auto/message/imageGenerationIntent";

describe("当前触发消息的明确生图意图", () => {
  test("接受明确要求产出图片的中英文与媒体改画表达", () => {
    for (const text of [
      "画一只猫",
      "帮我生成一张 16:9 壁纸",
      "你能帮我生成图片吗？",
      "做一张海报",
      "给我来张猫图",
      "把这张图重画成日系插画",
      "draw me a cat",
      "create a poster for this event",
      "猫のイラストを描いて",
    ]) {
      expect(hasExplicitImageGenerationIntent(text)).toBe(true);
    }
  });

  test("拒绝能力询问、图片讨论、场景描述与提示词请求", () => {
    for (const text of [
      undefined,
      "",
      "你会生图吗？",
      "你能生成图片吗？",
      "可以生成图片吗？",
      "我可以生成图片吗？",
      "这个功能可以生成图片吗？",
      "这个机器人支持画图功能吗",
      "这张图怎么样",
      "想象一个海边场景",
      "给我写一个生图 prompt",
      "generate a prompt for an image",
      "这幅画很好看",
    ]) {
      expect(hasExplicitImageGenerationIntent(text)).toBe(false);
    }
  });
});
