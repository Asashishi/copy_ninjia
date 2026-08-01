import { beforeEach, describe, expect, mock, test } from "bun:test";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../packages/consts/commands";

const sendMessage = mock(
  async (..._args: unknown[]): Promise<number | undefined> => 77
);
const deleteMessageAfter = mock((..._args: unknown[]): void => {});

mock.module("../../packages/infra/telegram/actions", () => ({
  deleteMessageAfter,
  sendMessage,
}));

const { sendCommandMessage } = await import(
  "../../packages/infra/telegram/commandMessages"
);

beforeEach(() => {
  sendMessage.mockClear();
  deleteMessageAfter.mockClear();
  sendMessage.mockImplementation(
    async (): Promise<number | undefined> => 77
  );
});

describe("sendCommandMessage", () => {
  test("群聊发送成功后统一安排 30 秒删除，并沿用同一个 API", async () => {
    const api: never = { kind: "test-api" } as never;

    await expect(sendCommandMessage({
      chatId: -1001,
      text: "提示",
      replyToMessageId: 10,
      api,
    })).resolves.toBe(77);

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: "提示",
      replyToMessageId: 10,
      api,
    });
    expect(deleteMessageAfter).toHaveBeenCalledWith({
      chatId: -1001,
      messageId: 77,
      delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
      api,
    });
  });

  test("私聊提示保持原有留存行为", async () => {
    await sendCommandMessage({ chatId: 1001, text: "私聊提示" });

    expect(deleteMessageAfter).not.toHaveBeenCalled();
  });

  test("明确授权长期留存的群聊内容不会自动删除", async () => {
    await sendCommandMessage({
      chatId: -1001,
      text: "帮助",
      preserveInGroup: true,
    });

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: "帮助",
    });
    expect(deleteMessageAfter).not.toHaveBeenCalled();
  });

  test("发送失败未取得消息 id 时不创建无效删除任务", async () => {
    sendMessage.mockImplementationOnce(
      async (): Promise<number | undefined> => undefined
    );

    await expect(sendCommandMessage({
      chatId: -1001,
      text: "未发送",
    })).resolves.toBeUndefined();

    expect(deleteMessageAfter).not.toHaveBeenCalled();
  });
});
