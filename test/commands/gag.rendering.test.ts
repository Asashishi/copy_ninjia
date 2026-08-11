/** `/gag` 参数解析与文本渲染；替身与工厂见 test/helpers/gagHarness.ts。 */

import { describe, expect, test } from "bun:test";
import {
  GAG_ELLIPSIS_PROBABILITY,
  GAG_REPLACEMENT_CHARACTERS,
} from "../../packages/consts/gag";
import {
  rendering,
  installGagTestHooks,
} from "../helpers/gagHarness";

installGagTestHooks();

describe("gag 参数与文本渲染", () => {
  test("普通按钮只带 gag 前缀，频道按钮额外解析规范负数 id 与会话令牌", () => {
    expect(rendering.parseGagInlineQuery("gag: 你好"))
      .toEqual({ text: "你好" });
    expect(rendering.parseGagInlineQuery("gag:7 你好")).toBeUndefined();
    expect(rendering.parseGagInlineQuery("gag:-1002233445566:0123456789abcdef 你好"))
      .toEqual({
        targetChannelId: -1002233445566,
        token: "0123456789abcdef",
        text: "你好",
      });
    // 少了令牌、令牌形态不对、或长度不足都必须整条判伪：频道分支没有别的
    // 发起者可比对，令牌就是那道闸。
    expect(rendering.parseGagInlineQuery("gag:-1002233445566 你好")).toBeUndefined();
    expect(rendering.parseGagInlineQuery("gag:-1002233445566: 你好")).toBeUndefined();
    expect(rendering.parseGagInlineQuery("gag:-1002233445566:0123456789ABCDEF 你好"))
      .toBeUndefined();
    expect(rendering.parseGagInlineQuery("gag:-1002233445566:0123456789abcde 你好"))
      .toBeUndefined();
    expect(rendering.parseGagInlineQuery("普通查询")).toBeUndefined();
  });

  test("每条会话的 inline 令牌互不相同且形态固定", () => {
    const first: string = rendering.createGagInlineToken();
    const second: string = rendering.createGagInlineToken();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
  });

  test("显式目标、回复目标、可选时长、默认用具和自由文本用具分别解析", () => {
    expect(rendering.parseGagCommand("@alice 5")).toEqual({
      durationMinutes: 5,
      rawTarget: "@alice",
      tool: "口塞",
    });
    expect(rendering.parseGagCommand("@alice")).toEqual({
      durationMinutes: 5,
      rawTarget: "@alice",
      tool: "口塞",
    });
    expect(rendering.parseGagCommand("@alice 丝带 结")).toEqual({
      durationMinutes: 5,
      rawTarget: "@alice",
      tool: "丝带 结",
    });
    expect(rendering.parseGagCommand("10 丝带 结", true)).toEqual({
      durationMinutes: 10,
      rawTarget: "",
      tool: "丝带 结",
    });
    expect(rendering.parseGagCommand("", true)).toEqual({
      durationMinutes: 5,
      rawTarget: "",
      tool: "口塞",
    });
    expect(rendering.parseGagCommand("绳子", true)).toEqual({
      durationMinutes: 5,
      rawTarget: "",
      tool: "绳子",
    });
    expect(rendering.parseGagCommand("7 绳子")).toEqual({
      durationMinutes: 5,
      rawTarget: "7",
      tool: "绳子",
    });
    expect(rendering.parseGagCommand("-1001234567890 15")).toEqual({
      durationMinutes: 15,
      rawTarget: "-1001234567890",
      tool: "口塞",
    });
    expect(rendering.parseGagCommand("7 绳子", true)).toBeUndefined();
    expect(rendering.parseGagCommand("@alice 20 绳子")).toBeUndefined();
  });

  test("75% 紧邻追加省略号、25% 随机替换且两个分支都不带空格", () => {
    const rolls: number[] = [
      0,
      0.749,
      0.75,
      0,
      0.8,
      0.999,
      0.5,
      0.99,
      0.5,
    ];
    let index: number = 0;
    const text: string = rendering.renderGagSpeech({
      text: "甲乙丙丁戊己",
      tool: "口塞",
      random: (): number => rolls[index++]!,
    });
    expect(text).toBe("（透过口塞）甲...乙...唔咕戊...哦");
    expect(text).not.toContain(" ");
    // 阈值只按实现里那一条 `roll < GAG_ELLIPSIS_PROBABILITY` 断言，不再用两个
    // 常量相加推导：那样改动 GAG_ELLIPSIS_PROBABILITY 时本用例仍然全绿，实际
    // 概率却已经偏离声明。
    expect(rendering.renderGagSpeech({
      text: "甲",
      tool: "口塞",
      random: (): number => GAG_ELLIPSIS_PROBABILITY - Number.EPSILON,
    })).toBe("（透过口塞）甲...");
    const replacedRolls: number[] = [GAG_ELLIPSIS_PROBABILITY, 0.999];
    let replacedIndex: number = 0;
    expect(rendering.renderGagSpeech({
      text: "甲",
      tool: "口塞",
      random: (): number => replacedRolls[replacedIndex++]!,
    })).toBe("（透过口塞）咕");
    expect(GAG_REPLACEMENT_CHARACTERS).toContain("咕");
  });

  test("组合 emoji 只按一个字形替换，空正文仍产出可发送内容", () => {
    expect(rendering.renderGagSpeech({
      text: "👨‍👩‍👧‍👦",
      tool: "丝带",
      random: (): number => 0.749,
    })).toBe("（透过丝带）👨‍👩‍👧‍👦...");
    const rolls: number[] = [0.75, 0.999];
    let index: number = 0;
    expect(rendering.renderGagSpeech({
      text: "👨‍👩‍👧‍👦",
      tool: "丝带",
      random: (): number => rolls[index++]!,
    })).toBe("（透过丝带）咕");
    expect(rendering.renderGagSpeech({
      text: "",
      tool: "口塞",
      random: (): number => 0.99,
    })).toBe("（透过口塞）...");
  });
});
