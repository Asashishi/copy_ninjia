import { describe, expect, mock, test } from "bun:test";

/**
 * ai/stickers.ts 经 infra/telegram -> infra/logger -> infra/diskIO，后者在
 * 模块顶层就会 `new Worker(...)`：单测里绝不能让它真的跑起来（理由同
 * test/commands/luckChallenge.test.ts 的模块头注释），先 mock 掉再动态 import。
 * infra/telegram 的 sendSticker 也一并 mock 成测试可控的假实现——本文件
 * 不关心真实 Telegram API 调用是否成功（那部分已用真实 API 手动验证过），
 * 只关心 stickers.ts 自己的解析/组装/分发逻辑。
 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const realTelegram = await import("../../src/infra/telegram");
const sendStickerMock = mock(async (_chatId: number, _fileId: string): Promise<number | undefined> => 12345);
mock.module("../../src/infra/telegram", () => ({ ...realTelegram, sendSticker: sendStickerMock }));

const { buildSendStickerToolDefinition, parseStickerToolIndex, sendStickerTool } = await import("../../src/ai/stickers");
const { SEND_STICKER_TOOL } = await import("../../src/consts/tools");

function candidate(fileId: string, emoji: string, description: string): any {
  return { sticker: { file_id: fileId, file_unique_id: `${fileId}-uid`, emoji }, emoji, description };
}

describe("ai/stickers parseStickerToolIndex", () => {
  test("合法 JSON 参数原样解析", () => {
    expect(parseStickerToolIndex('{"index": 3}', 5)).toBe(3);
    expect(parseStickerToolIndex('{"index": 1}', 1)).toBe(1);
  });

  test("JSON 解析失败返回 null", () => {
    expect(parseStickerToolIndex("not json", 5)).toBeNull();
    expect(parseStickerToolIndex("", 5)).toBeNull();
  });

  test("index 字段缺失/类型不对/不是整数，返回 null", () => {
    expect(parseStickerToolIndex("{}", 5)).toBeNull();
    expect(parseStickerToolIndex('{"index": "3"}', 5)).toBeNull();
    expect(parseStickerToolIndex('{"index": 2.5}', 5)).toBeNull();
    expect(parseStickerToolIndex('{"index": null}', 5)).toBeNull();
  });

  test("越界编号（0、负数、超出候选数）返回 null", () => {
    expect(parseStickerToolIndex('{"index": 0}', 5)).toBeNull();
    expect(parseStickerToolIndex('{"index": -1}', 5)).toBeNull();
    expect(parseStickerToolIndex('{"index": 6}', 5)).toBeNull();
  });

  test("候选数为 0 时任何编号都越界", () => {
    expect(parseStickerToolIndex('{"index": 1}', 0)).toBeNull();
  });
});

describe("ai/stickers buildSendStickerToolDefinition", () => {
  test("候选为空时不提供工具（返回 null）", () => {
    expect(buildSendStickerToolDefinition([])).toBeNull();
  });

  test("候选非空时组装带编号清单的工具定义", () => {
    const def = buildSendStickerToolDefinition([candidate("id1", "😂", "一只猫大笑"), candidate("id2", "😭", "一个人哭泣")]);
    expect(def?.name).toBe(SEND_STICKER_TOOL);
    expect(def?.description).toContain("1. 😂 一只猫大笑");
    expect(def?.description).toContain("2. 😭 一个人哭泣");
    expect(def?.parameters.required).toEqual(["index"]);
  });

  test("贴纸没有 emoji 时用占位文案，不留空", () => {
    const def = buildSendStickerToolDefinition([candidate("id1", "", "一个没有 emoji 的贴纸")]);
    expect(def?.description).toContain("1. （无 emoji） 一个没有 emoji 的贴纸");
  });
});

describe("ai/stickers sendStickerTool", () => {
  test("编号非法时不调用 sendSticker，返回错误结果", async () => {
    sendStickerMock.mockClear();
    const result = await sendStickerTool(123, [candidate("id1", "😂", "desc")], '{"index": 99}', () => {});
    expect(result).toBe(JSON.stringify({ error: "Invalid sticker index" }));
    expect(sendStickerMock).not.toHaveBeenCalled();
  });

  test("编号合法时发送对应候选、回调 onSent、返回成功结果", async () => {
    sendStickerMock.mockClear();
    sendStickerMock.mockImplementationOnce(async () => 999);
    let recorded: [string, number] | null = null;

    const result = await sendStickerTool(
      123,
      [candidate("id1", "😂", "第一枚"), candidate("id2", "😭", "第二枚")],
      '{"index": 2}',
      (desc, messageId) => {
        recorded = [desc, messageId];
      }
    );

    expect(sendStickerMock).toHaveBeenCalledWith(123, "id2");
    expect(result).toBe(JSON.stringify({ success: true }));
    expect(recorded).not.toBeNull();
    expect(recorded![1]).toBe(999);
    expect(recorded![0]).toContain("第二枚");
  });

  test("Telegram 发送失败（sendSticker 返回 undefined）时不回调 onSent，返回错误结果", async () => {
    sendStickerMock.mockClear();
    sendStickerMock.mockImplementationOnce(async () => undefined);
    let called = false;

    const result = await sendStickerTool(123, [candidate("id1", "😂", "desc")], '{"index": 1}', () => {
      called = true;
    });

    expect(result).toBe(JSON.stringify({ error: "Failed to send sticker" }));
    expect(called).toBe(false);
  });
});
