/** `/gag` 参数解析与文本渲染；替身与工厂见 test/helpers/gagHarness.ts。 */

import { describe, expect, test } from "bun:test";
import {
  GAG_FILL_OPERATION_PROBABILITY,
  GAG_REPLACEMENT_CHARACTERS,
} from "../../packages/consts/gag";
import {
  identity,
  rendering,
  installGagTestHooks,
} from "../helpers/gagHarness";

installGagTestHooks();

describe("gag 参数与文本渲染", () => {
  test("用户和频道入口只解析目标 ID，并拒绝摘要、token 与群 ID 后缀", () => {
    expect(rendering.parseGagInlineQuery("gag:7 你好"))
      .toEqual({ targetId: 7, text: "你好" });
    expect(rendering.parseGagInlineQuery("gag:-1002233445566 你好"))
      .toEqual({ targetId: -1002233445566, text: "你好" });
    expect(rendering.parseGagInlineQuery("gag: 你好")).toBeUndefined();
    expect(rendering.parseGagInlineQuery("gag:0 你好")).toBeUndefined();
    expect(rendering.parseGagInlineQuery("gag:07 你好")).toBeUndefined();
    expect(rendering.parseGagInlineQuery("gag:+7 你好")).toBeUndefined();
    expect(rendering.parseGagInlineQuery("gag:9007199254740992 你好"))
      .toBeUndefined();
    expect(rendering.parseGagInlineQuery(
      "gag:8f14e45fceea167a5a36dedd4bea2543 你好"
    )).toBeUndefined();
    expect(rendering.parseGagInlineQuery(
      "gag:-1002233445566:0123456789abcdef 你好"
    )).toBeUndefined();
    expect(rendering.parseGagInlineQuery(
      "gag:7:-1001 你好"
    )).toBeUndefined();
    expect(rendering.parseGagInlineQuery("普通查询")).toBeUndefined();
  });

  test("隐藏校验链接以目标主页绑定身份，并把超级群 ID 挂在 fragment", () => {
    expect(identity.createGagTargetProfileUrl({
      id: 7,
      username: "alice",
    })).toBe("https://t.me/alice?profile");
    expect(identity.createGagTargetProfileUrl({ id: 7 }))
      .toBe("tg://user?id=7");
    expect(identity.createGagTargetProfileUrl({
      id: -1002233445566,
      username: "alice_channel",
      isChannel: true,
    })).toBe("https://t.me/alice_channel?profile");
    expect(identity.createGagTargetProfileUrl({
      id: -1002233445566,
      isChannel: true,
    })).toBe("https://t.me/c/2233445566/1");
    expect(identity.isGagInlineMarkerUrl("tg://user?id=7#-1001")).toBeTrue();
    expect(identity.isGagInlineMarkerUrl(
      "https://t.me/alice?profile#-1001"
    )).toBeTrue();
    expect(identity.isGagInlineMarkerUrl(
      "https://t.me/c/2233445566/1#-1001"
    )).toBeTrue();
    expect(identity.isGagInlineMarkerUrl(
      "https://t.me/alice?profile#7"
    )).toBeFalse();
    expect(identity.isGagInlineMarkerUrl("https://t.me/alice#-1001"))
      .toBeFalse();
    expect(identity.isGagInlineMarkerUrl(
      "https://t.me/c/2233445566#-1001"
    )).toBeFalse();
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

  test("填充均匀生成 3~6 个点，每个点间独立以 1/3 概率插入空格", () => {
    const threeDotRolls: number[] = [
      GAG_FILL_OPERATION_PROBABILITY - Number.EPSILON,
      0,
      0.5,
      0.5,
    ];
    let threeDotIndex: number = 0;
    expect(rendering.renderGagSpeech({
      text: "甲",
      tool: "口塞",
      random: (): number => threeDotRolls[threeDotIndex++]!,
    })).toBe("（透过口塞）甲...");

    const sixSpacedDotRolls: number[] = [0, 0.999, 0, 0, 0, 0, 0];
    let sixSpacedDotIndex: number = 0;
    expect(rendering.renderGagSpeech({
      text: "甲",
      tool: "口塞",
      random: (): number => sixSpacedDotRolls[sixSpacedDotIndex++]!,
    })).toBe("（透过口塞）甲. . . . . .");

    const replacedRolls: number[] = [
      GAG_FILL_OPERATION_PROBABILITY,
      0.999,
    ];
    let replacedIndex: number = 0;
    expect(rendering.renderGagSpeech({
      text: "甲",
      tool: "口塞",
      random: (): number => replacedRolls[replacedIndex++]!,
    })).toBe("（透过口塞）咕");
    expect(GAG_REPLACEMENT_CHARACTERS).toContain("咕");
  });

  test("填充和替换都不连续三次，短文本保底不足时改走另一类操作", () => {
    expect(rendering.renderGagSpeech({
      text: "甲乙丙丁戊己庚辛",
      tool: "口塞",
      random: (): number => 0,
    })).toBe(
      "（透过口塞）甲. . .乙. . .丙丁. . .戊. . .唔庚. . .辛. . ."
    );
    expect(rendering.renderGagSpeech({
      text: "甲乙丙丁戊己",
      tool: "口塞",
      random: (): number => 0.999,
    })).toBe("（透过口塞）咕咕丙咕咕己");
  });

  test("操作保底按字形数分档，超过 64 个字形恢复无保底抽样", () => {
    const counts: readonly number[] = [0, 1, 2, 3, 4, 7, 8, 31, 32, 64, 65];
    expect(counts.map((count: number): number =>
      rendering.gagMinimumOperationCount(count)
    )).toEqual([0, 1, 2, 2, 3, 3, 7, 7, 15, 15, 0]);
  });

  test("最坏六点全空格填充仍受 Telegram 消息长度预检约束", () => {
    expect(rendering.canRenderMaximumInlineQuery("甲".repeat(1_020))).toBeTrue();
    expect(rendering.canRenderMaximumInlineQuery("甲".repeat(1_021))).toBeFalse();
  });

  test("组合 emoji 只按一个字形操作，空正文仍产出随机点填充", () => {
    const fillRolls: number[] = [0, 0, 0.5, 0.5];
    let fillIndex: number = 0;
    expect(rendering.renderGagSpeech({
      text: "👨‍👩‍👧‍👦",
      tool: "丝带",
      random: (): number => fillRolls[fillIndex++]!,
    })).toBe("（透过丝带）👨‍👩‍👧‍👦...");
    const replacementRolls: number[] = [
      GAG_FILL_OPERATION_PROBABILITY,
      0.999,
    ];
    let replacementIndex: number = 0;
    expect(rendering.renderGagSpeech({
      text: "👨‍👩‍👧‍👦",
      tool: "丝带",
      random: (): number => replacementRolls[replacementIndex++]!,
    })).toBe("（透过丝带）咕");
    expect(rendering.renderGagSpeech({
      text: "",
      tool: "口塞",
      random: (): number => 0.99,
    })).toBe("（透过口塞）......");
  });
});
