import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * 问答直答的发送边界。判定那一半在 qaDirectAnswer.test.ts；这里验证两件发送侧的事：
 * 1. 答案走 sendMessage，不走命令提示的延迟清理边界（`AGENTS.md` 的长期保留例外）；
 * 2. 论坛群里带上话题：答案长期留在群里，不只靠 reply_parameters。
 */

interface CapturedSend {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
  readonly messageThreadId?: number;
}

const sends: CapturedSend[] = [];
const sendCommandMessage = mock((): Promise<undefined> => Promise.resolve(undefined));

mock.module("../../packages/infra/telegram", () => ({
  sendMessage: (params: CapturedSend): Promise<number> => {
    sends.push(params);
    return Promise.resolve(4242);
  },
  sendCommandMessage,
}));

const { sendQaDirectAnswer } = await import("../../packages/auto/message/qaDirectAnswer");

beforeEach((): void => {
  sends.length = 0;
  sendCommandMessage.mockClear();
});

describe("群问答直答的发送边界", () => {
  test("答案走 sendMessage，不进命令的 30 秒清理边界", async () => {
    await sendQaDirectAnswer({
      chatId: -1001,
      replyToMessageId: 7,
      answer: "点置顶那条链接",
      messageThreadId: undefined,
    });

    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe("点置顶那条链接");
    expect(sends[0]?.replyToMessageId).toBe(7);
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("论坛话题里的提问，答案带着话题发回去", async () => {
    await sendQaDirectAnswer({
      chatId: -1001,
      replyToMessageId: 7,
      answer: "点置顶那条链接",
      messageThreadId: 55,
    });

    expect(sends[0]?.messageThreadId).toBe(55);
  });

  test("General 与非论坛群不设置话题参数", async () => {
    await sendQaDirectAnswer({
      chatId: -1001,
      replyToMessageId: 7,
      answer: "点置顶那条链接",
      messageThreadId: undefined,
    });

    expect(sends[0]?.messageThreadId).toBeUndefined();
  });
});
