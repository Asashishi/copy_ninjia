import { expect, mock, test } from "bun:test";
import { mediaTaskRunner } from "../../../packages/cache/workers/aiChat/mediaTasks";
import { imageGenerationClaimTimes, resetImageGenerationCache } from "../../../packages/cache/workers/aiChat/imageGeneration";
import { MEDIA_DESCRIPTION_MAX_CONCURRENCY } from "../../../packages/consts/aiChat/media";
import { GENERATE_IMAGE_TOOL } from "../../../packages/consts/tools";
import { waitUntil } from "../../helpers/waitUntil";
import type { ReplyActionChains, ReplyToolContext, ReplyToolExecution } from "../../../packages/types/aiChat/replies";

const downloadTelegramVisionImage = mock(async (): Promise<null> => null);
const generateChatImage = mock(async (): Promise<null> => null);
const sendPhotoWithResult = mock(async (): Promise<undefined> => undefined);
const realTelegram = await import("../../../packages/infra/telegram");
mock.module("../../../packages/aiChat/ai/telegramImage", () => ({ downloadTelegramVisionImage }));
mock.module("../../../packages/aiChat/ai/imageGeneration", () => ({ generateChatImage }));
mock.module("../../../packages/infra/telegram", () => ({ ...realTelegram, sendPhotoWithResult }));

const { createGenerateImageExecutor } = await import("../../../packages/aiChat/ai/tools/replyToolset/imageGeneration");
const { createRoundMessageState } = await import("../../../packages/aiChat/ai/tools/replyToolset/messageState");
const { createReplyActionChains } = await import("../../../packages/aiChat/ai/tools/replyToolset/actionChains");

test("满载媒体队列中的参考生图取消后立即排空动作链并释放冷却占位", async (): Promise<void> => {
  resetImageGenerationCache();
  const occupied: PromiseWithResolvers<null> = Promise.withResolvers<null>();
  const active: Promise<null | undefined>[] = [];
  for (let index: number = 0; index < MEDIA_DESCRIPTION_MAX_CONCURRENCY; index++) {
    active.push(mediaTaskRunner.run("interactive", (): Promise<null> => occupied.promise));
  }
  const controller: AbortController = new AbortController();
  const context: ReplyToolContext = {
    chatId: -100123, replyToMessageId: 1, messageThreadId: undefined,
    mediaToolsRequested: true,
    imageGenerationReference: { fileId: "mock-reference", fileUniqueId: "mock-unique", width: 64, height: 64 },
    bypassMediaToolCooldown: false,
    chatAction: { set: (): number => 0, settle: async (): Promise<void> => {} },
    direct: true, roundHasTypo: false,
    isActive: (): boolean => !controller.signal.aborted, signal: controller.signal,
    onMessageSent: (): void => {}, onStickerSent: (): void => {},
    onImageSent: (): void => {}, onVoiceSent: (): void => {},
  };
  let action: Promise<void> | undefined;
  try {
    const execution: ReplyToolExecution = createGenerateImageExecutor(context, createRoundMessageState(), (): number => 0)(
      JSON.stringify({ prompt: "mock image" })
    );
    if (typeof execution === "string") throw new Error("The fixture must enqueue an image action.");
    const chains: ReplyActionChains = createReplyActionChains(context);
    chains.start(GENERATE_IMAGE_TOOL, execution.run);
    let settled: boolean = false;
    action = chains.settle().then((): void => { settled = true; });
    await waitUntil((): boolean => mediaTaskRunner.pendingCount === 1);
    expect(mediaTaskRunner.pendingCount).toBe(1);
    expect(imageGenerationClaimTimes.has(context.chatId)).toBe(true);
    controller.abort();
    await waitUntil((): boolean => settled);
    expect({ pending: mediaTaskRunner.pendingCount, settled, claimed: imageGenerationClaimTimes.has(context.chatId) }).toEqual({
      pending: 0, settled: true, claimed: false,
    });
    expect(mediaTaskRunner.activeCount).toBe(MEDIA_DESCRIPTION_MAX_CONCURRENCY);
    expect(downloadTelegramVisionImage).not.toHaveBeenCalled();
    expect(generateChatImage).not.toHaveBeenCalled();
    expect(sendPhotoWithResult).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    occupied.resolve(null);
    await Promise.allSettled(active);
    await action;
    resetImageGenerationCache();
  }
});
