import { mock } from "bun:test";
import type { ReplyToolContext } from "../../packages/types/aiChat/replies";

/**
 * 按次回复工具集（createReplyToolset）的最小上下文：群 -100800、回复消息 10、非直接轮、无话题，
 * 媒体工具未请求、无手滑，回调与聊天状态句柄都是空替身。各用例按需覆盖字段。
 */
export function replyToolContextFixture(overrides: Partial<ReplyToolContext> = {}): ReplyToolContext {
  return {
    chatId: -100800,
    replyToMessageId: 10,
    messageThreadId: undefined,
    mediaToolsRequested: false,
    bypassMediaToolCooldown: false,
    direct: false,
    chatAction: {
      set: mock((..._args: unknown[]): number => 0),
      settle: mock(async (): Promise<void> => {}),
    },
    roundHasTypo: false,
    isActive: (): boolean => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onVoiceSent: mock((..._args: unknown[]): void => {}),
    ...overrides,
  };
}
