/**
 * generate_song 的直接触发资格、供应商能力挂载与未知工具分发契约。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReplyToolContext, ReplyToolset } from "../../../packages/types/aiChat/replies";
import type { AiToolDefinition } from "../../../packages/types/aiChat/provider";

const generateSong = mock(async (..._args: unknown[]): Promise<null> => null);
const songAiProvider = mock((): unknown => ({ name: "google", generateSong }));
const realTelegram = await import("../../../packages/infra/telegram");
// 保留同模块的真实导出，只替换本测试观测的两个 provider selector。
const realProvider = await import("../../../packages/aiChat/provider");
const configuredImageAiProvider = realProvider.imageAiProvider;
const imageAiProvider = mock((): unknown => configuredImageAiProvider());

mock.module("../../../packages/aiChat/provider", () => ({
  ...realProvider,
  imageAiProvider,
  songAiProvider,
}));
mock.module("../../../packages/infra/telegram", () => ({
  ...realTelegram,
  telegramApi: { getStickerSet: mock(async (): Promise<null> => null) },
}));

const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");
const { GENERATE_IMAGE_TOOL, GENERATE_SONG_TOOL, ACTION_TOOL_NAMES } = await import("../../../packages/consts/tools");

function buildContext(mediaToolsRequested: boolean = true): ReplyToolContext {
  return {
    chatId: -1001,
    replyToMessageId: 42,
    messageThreadId: undefined,
    mediaToolsRequested,
    bypassMediaToolCooldown: false,
    chatAction: {
      current: (): "idle" => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onSongSent: mock((..._args: unknown[]): void => {}),
  };
}

function toolNames(toolset: ReplyToolset): string[] {
  return toolset.functions.map((definition: AiToolDefinition): string => definition.name);
}

beforeEach(() => {
  songAiProvider.mockClear();
  imageAiProvider.mockClear();
  generateSong.mockClear();
  songAiProvider.mockImplementation((): unknown => ({ name: "google", generateSong }));
  imageAiProvider.mockImplementation((): unknown => configuredImageAiProvider());
});

describe("生歌工具的可选挂载", () => {
  test("非直接触发轮不查询供应商，也不暴露重媒体工具", async () => {
    const toolset: ReplyToolset = await createReplyToolset(buildContext(false));

    expect(songAiProvider).not.toHaveBeenCalled();
    expect(imageAiProvider).not.toHaveBeenCalled();
    expect(toolNames(toolset)).not.toContain(GENERATE_SONG_TOOL);
    expect(toolNames(toolset)).not.toContain(GENERATE_IMAGE_TOOL);
    expect(toolset.has(GENERATE_SONG_TOOL)).toBe(false);
    expect(toolset.has(GENERATE_IMAGE_TOOL)).toBe(false);
  });

  test("供应商实现了 generateSong 时才挂 generate_song", async () => {
    const toolset: ReplyToolset = await createReplyToolset(buildContext());

    expect(toolNames(toolset)).toContain(GENERATE_SONG_TOOL);
    expect(toolset.has(GENERATE_SONG_TOOL)).toBe(true);
  });

  test("供应商没有这项能力时整个不挂，生图等必备工具不受影响", async () => {
    songAiProvider.mockImplementation((): unknown => null);
    const toolset: ReplyToolset = await createReplyToolset(buildContext());

    expect(toolNames(toolset)).not.toContain(GENERATE_SONG_TOOL);
    expect(toolNames(toolset)).toContain(GENERATE_IMAGE_TOOL);
    expect(toolset.has(GENERATE_SONG_TOOL)).toBe(false);
  });

  test("没挂时仍被模型点名调用，归一成 Unknown tool 而不是对 undefined 取调用", async () => {
    songAiProvider.mockImplementation((): unknown => null);
    const toolset: ReplyToolset = await createReplyToolset(buildContext());

    const result = JSON.parse(await toolset.execute(GENERATE_SONG_TOOL, JSON.stringify({ prompt: "p" })));
    expect(result.error).toBe(`Unknown tool: ${GENERATE_SONG_TOOL}`);
    expect(generateSong).not.toHaveBeenCalled();
    expect(toolset.actionsUsed()).toBe(0);
  });

  test("image 未配置时不挂 generate_image，也不影响文本与其它工具", async () => {
    imageAiProvider.mockImplementation((): unknown => null);
    const toolset: ReplyToolset = await createReplyToolset(buildContext());

    expect(toolNames(toolset)).not.toContain(GENERATE_IMAGE_TOOL);
    expect(toolset.has(GENERATE_IMAGE_TOOL)).toBe(false);
    const result = JSON.parse(await toolset.execute(GENERATE_IMAGE_TOOL, JSON.stringify({ prompt: "p" })));
    expect(result.error).toBe(`Unknown tool: ${GENERATE_IMAGE_TOOL}`);
  });

  test("generate_song 恒在动作预算清单里——那份清单回答的是「算不算可见动作」", () => {
    // 本轮有没有这个工具由 toolset.has 回答，两件事不能混在一张表里。
    expect(ACTION_TOOL_NAMES).toContain(GENERATE_SONG_TOOL);
  });
});
