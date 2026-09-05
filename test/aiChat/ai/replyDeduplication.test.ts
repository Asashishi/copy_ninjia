import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReplyToolContext, ReplyToolset, RoundMessageState } from "../../../packages/types/aiChat/replies";
import type { TelegramSendResult } from "../../../packages/types/telegram";

let nextMessageId: number = 100;
const sendMessage = mock(async (..._args: unknown[]): Promise<TelegramSendResult | undefined> => ({
  messageId: nextMessageId++,
}));
const realTelegram = await import("../../../packages/infra/telegram");
mock.module("../../../packages/infra/telegram", () => ({
  ...realTelegram,
  telegramApi: { getStickerSet: mock(async (): Promise<null> => null) },
  sendMessageWithResult: sendMessage,
}));
mock.module("../../../packages/libs/sleep", () => ({
  sleep: mock(async (): Promise<void> => {}),
}));

const { SEND_MESSAGE_TOOL } = await import("../../../packages/consts/tools");
const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");
const { createSendMessageExecutor } = await import("../../../packages/aiChat/ai/tools/replyToolset/sendMessage");
const { createRoundMessageState } = await import("../../../packages/aiChat/ai/tools/replyToolset/messageState");
const { modelAuthoredTextPolicyResult } = await import("../../../packages/aiChat/ai/tools/replyToolset/modelAuthoredText");

function context(): ReplyToolContext {
  return {
    chatId: -100800,
    replyToMessageId: 10,
    messageThreadId: undefined,
    mediaToolsRequested: false,
    bypassMediaToolCooldown: false,
    chatAction: {
      current: () => "idle",
      set: mock((): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: (): boolean => true, release: (): void => {} },
    roundHasTypo: false,
    isActive: (): boolean => true,
    onMessageSent: mock((): void => {}),
    onStickerSent: mock((): void => {}),
    onImageSent: mock((): void => {}),
    onSongSent: mock((): void => {}),
  };
}

beforeEach(() => {
  nextMessageId = 100;
  sendMessage.mockReset();
  sendMessage.mockImplementation(async (): Promise<TelegramSendResult> => ({ messageId: nextMessageId++ }));
});

describe("单轮回复静默去重", () => {
  test("换行、连续空白和 Unicode 等价编码不产生第二次发送或动作计数", async () => {
    const ctx: ReplyToolContext = context();
    const toolset: ReplyToolset = await createReplyToolset(ctx);
    await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "café 明天见" }));

    const duplicate: string = await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
      text: "  cafe\u0301\n\t明天见  ",
      reply_to_trigger: true,
    }));

    expect(JSON.parse(duplicate)).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.onMessageSent).toHaveBeenCalledTimes(1);
    expect(ctx.chatAction.settle).toHaveBeenCalledTimes(1);
    expect(toolset.actionsUsed()).toBe(1);

    await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "后天再聚" }));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(toolset.actionsUsed()).toBe(2);
  });

  test("清洗包裹符号后同样判重，丢弃不会追加输入状态或记忆", async () => {
    const ctx: ReplyToolContext = context();
    const toolset: ReplyToolset = await createReplyToolset(ctx);
    await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "明天见" }));
    for (const text of ["「明天见」", "```\n明天见\n```", "明天见"]) {
      expect(JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text })))).toEqual({
        success: true, skipped: "duplicate", actions_used: 0,
      });
    }
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.onMessageSent).toHaveBeenCalledTimes(1);
    expect(ctx.chatAction.settle).toHaveBeenCalledTimes(1);
    expect(toolset.actionsUsed()).toBe(1);
  });

  test("未发送成功的内容可以重试，成功后的重复才丢弃", async () => {
    sendMessage.mockImplementationOnce(async (): Promise<undefined> => undefined);
    const toolset: ReplyToolset = await createReplyToolset(context());
    const args: string = JSON.stringify({ text: "明天见" });
    expect(JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, args)).error).toBe("Failed to send message");
    expect(toolset.actionsUsed()).toBe(0);
    expect(JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, args)).message_id).toBe(100);
    expect(JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, args)).skipped).toBe("duplicate");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(toolset.actionsUsed()).toBe(1);
  });

  test("下一轮独立判断，不把历史上的正常同文回复永久屏蔽", async () => {
    for (let round: number = 0; round < 2; round++) {
      const toolset: ReplyToolset = await createReplyToolset(context());
      expect(JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "晚安" }))).success).toBe(true);
      expect(toolset.actionsUsed()).toBe(1);
    }
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("已发送的媒体附言阻止同轮独立文字重发", async () => {
    const ctx: ReplyToolContext = context();
    const state: RoundMessageState = createRoundMessageState();
    state.sentCanonicalTexts.set(70, "今晚 月色不错");
    const execute = createSendMessageExecutor(ctx, state, (): number => 1);
    expect(JSON.parse(await execute(JSON.stringify({ text: "今晚\n月色不错" })))).toEqual({
      success: true, skipped: "duplicate", actions_used: 0,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    expect(ctx.chatAction.set).not.toHaveBeenCalled();
  });

  test("正文、图片附言、歌曲附言共享同一去重回执，标点与字词有差异时仍可发送", () => {
    const state: RoundMessageState = createRoundMessageState();
    state.sentCanonicalTexts.set(70, "今晚 月色不错");
    for (const surface of ["message", "picture", "song"] as const) {
      expect(JSON.parse(modelAuthoredTextPolicyResult("今晚\n月色不错", state, surface)!)).toEqual({
        success: true, skipped: "duplicate", actions_used: 0,
      });
      expect(modelAuthoredTextPolicyResult("今晚 月色不错？", state, surface)).toBeNull();
      expect(modelAuthoredTextPolicyResult("明晚 月色不错", state, surface)).toBeNull();
    }
  });
});
