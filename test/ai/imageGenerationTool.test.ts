import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReplyToolContext } from "../../src/types/aiChat/replies";

const generatedBytes: Uint8Array = new Uint8Array([1, 2, 3]);
const generateChatImage = mock(async (..._args: unknown[]): Promise<{
  bytes: Uint8Array;
  mimeType: "image/png";
} | null> => ({ bytes: generatedBytes, mimeType: "image/png" }));
const normalizeImageAspectRatio = mock((requested: string | undefined) => {
  if (requested === undefined || requested.trim() === "") return "1:1" as const;
  if (requested === "7:5") return "4:3" as const;
  if (requested === "16:9") return "16:9" as const;
  return null;
});
const sendPhoto = mock(async (..._args: unknown[]): Promise<number | undefined> => 77);
const realImageGeneration = await import("../../src/ai/imageGeneration");
const realTelegram = await import("../../src/infra/telegram");

mock.module("../../src/ai/imageGeneration", () => ({
  ...realImageGeneration,
  generateChatImage,
  normalizeImageAspectRatio,
}));
mock.module("../../src/infra/telegram", () => ({ ...realTelegram, sendPhoto }));

const { buildGenerateImageToolDefinition, createGenerateImageExecutor } = await import("../../src/ai/tools/replyToolset/imageGeneration");
const { claimImageGeneration, resetImageGenerationCache } = await import("../../src/cache/aiChat/imageGeneration");

function buildContext(chatId: number = -1001, bypass: boolean = false): ReplyToolContext {
  return {
    chatId,
    replyToMessageId: 42,
    bypassImageGenerationCooldown: bypass,
    chatAction: {
      current: () => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
  };
}

beforeEach(() => {
  resetImageGenerationCache();
  generateChatImage.mockClear();
  generateChatImage.mockResolvedValue({ bytes: generatedBytes, mimeType: "image/png" });
  normalizeImageAspectRatio.mockClear();
  sendPhoto.mockClear();
  sendPhoto.mockResolvedValue(77);
});

afterEach(() => {
  resetImageGenerationCache();
});

describe("generate_image 工具执行器", () => {
  test("动态工具说明告知模型当前是否可以生图", () => {
    expect(buildGenerateImageToolDefinition(buildContext()).description).toContain("当前状态：可以生图");

    claimImageGeneration({ chatId: -1001, bypassCooldown: false });
    const coolingDescription = buildGenerateImageToolDefinition(buildContext()).description;
    expect(coolingDescription).toContain("当前状态：暂不可生图");
    expect(coolingDescription).toContain("本轮不要调用");

    const superAdminDescription = buildGenerateImageToolDefinition(buildContext(-1001, true)).description;
    expect(superAdminDescription).toContain("当前状态：可以生图");
    expect(superAdminDescription).toContain("superAdmin");
  });

  test("归一化比例、回复触发消息并登记滚动记忆", async () => {
    const ctx: ReplyToolContext = buildContext();
    const execute = createGenerateImageExecutor(ctx);

    const result = JSON.parse(await execute(JSON.stringify({ prompt: "  日落下的纸飞机  ", aspect_ratio: "7:5" })));

    expect(result).toEqual({ success: true, message_id: 77, aspect_ratio: "4:3", resolution: "1K" });
    expect(generateChatImage).toHaveBeenCalledWith("日落下的纸飞机", "4:3");
    expect(sendPhoto).toHaveBeenCalledWith({
      chatId: -1001,
      bytes: generatedBytes,
      mimeType: "image/png",
      replyToMessageId: 42,
    });
    expect(ctx.onImageSent).toHaveBeenCalledWith("（生成并发送了一张图片：日落下的纸飞机）", 77);
  });

  test("普通用户同群第二次被拒绝，不同群独立放行", async () => {
    const first = createGenerateImageExecutor(buildContext(-1001));
    const sameChat = createGenerateImageExecutor(buildContext(-1001));
    const otherChat = createGenerateImageExecutor(buildContext(-1002));

    expect(JSON.parse(await first(JSON.stringify({ prompt: "first" }))).success).toBe(true);
    const limited = JSON.parse(await sameChat(JSON.stringify({ prompt: "second" })));
    expect(limited.error).toContain("cooling down");
    expect(limited.retry_after_seconds).toBeGreaterThan(0);
    expect(JSON.parse(await otherChat(JSON.stringify({ prompt: "third" }))).success).toBe(true);
    expect(generateChatImage).toHaveBeenCalledTimes(2);
  });

  test("失败尝试仍占冷却，superAdmin 则可连续调用", async () => {
    generateChatImage.mockResolvedValueOnce(null);
    const normal = createGenerateImageExecutor(buildContext(-1001));
    expect(JSON.parse(await normal(JSON.stringify({ prompt: "failed" }))).error).toContain("failed");
    expect(JSON.parse(await normal(JSON.stringify({ prompt: "retry" }))).error).toContain("cooling down");

    const superAdmin = createGenerateImageExecutor(buildContext(-1001, true));
    expect(JSON.parse(await superAdmin(JSON.stringify({ prompt: "admin one" }))).success).toBe(true);
    expect(JSON.parse(await superAdmin(JSON.stringify({ prompt: "admin two" }))).success).toBe(true);
  });
});
