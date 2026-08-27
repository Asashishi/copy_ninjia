import { beforeEach, describe, expect, test } from "bun:test";
// 公共模块桩收在 helper 里；必须在下面的 await import 之前登记。
import {
  autoMessageChatState,
  autoMessageQaEntries,
  generateAndSendReplyMock,
  recordChatMessageMock,
  resetAutoMessageMocks,
  sendMessageMock,
} from "../helpers/autoMessageMocks";

/**
 * 问答直答在**消息主干上的位置**（`auto/message/index.ts`）。
 *
 * 命中判定与渲染各有叶子用例（`qaDirectAnswer.test.ts`、`qaDirectAnswerSend.test.ts`）；
 * 这里钉的是只有主干才表达得出来的两条约束：命中必须**排在 AI 触发之前**（否则一条
 * 写死的答案还要白付一次模型调用），且命中即**终止本条消息的后续处理**。
 *
 * 因此正反两面都用同一条 `@机器人 怎么入群？`：它本身就是 AI 的直接触发条件，
 * 关掉直答的任一前提，断言就会翻到「进 AI」那一侧。
 */

const { handleIncomingMessageMiddleware } = await import("../../packages/auto/message");

const botInfo = { id: 999999, username: "test_bot", first_name: "TestBot" };
const CHAT_ID: number = -100800;
const MENTION: string = `@${botInfo.username}`;

function groupMessage(text: string, entities?: readonly unknown[]): any {
  return {
    me: botInfo,
    msg: {
      message_id: 8,
      date: 1,
      chat: { id: CHAT_ID, type: "supergroup", title: "Test Group" },
      from: { id: 123, is_bot: false, username: "alice", first_name: "Alice" },
      text,
      ...(entities === undefined ? {} : { entities: [...entities] }),
    },
  };
}

/** `@机器人 <正文>`：AI 的直接触发条件，不受随机掷骰影响。 */
function mentioning(text: string): any {
  return groupMessage(`${MENTION} ${text}`, [
    { type: "mention", offset: 0, length: MENTION.length },
  ]);
}

describe("问答直答在消息主干上的位置", () => {
  beforeEach(() => {
    resetAutoMessageMocks();
    autoMessageChatState.isInitEnabled = true;
    autoMessageQaEntries.set("怎么入群？", "点置顶");
  });

  test("命中时直接回答，并且不进 AI——写死的答案不该再付一次模型调用", async () => {
    await handleIncomingMessageMiddleware(mentioning("怎么入群？"));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toMatchObject({
      chatId: CHAT_ID,
      text: "点置顶",
      replyToMessageId: 8,
    });
    // 本文件存在的理由：直答必须排在 AI 触发之前。
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("命中即终止本条消息的后续处理，转录也不再记一遍", async () => {
    await handleIncomingMessageMiddleware(mentioning("怎么入群？"));

    expect(recordChatMessageMock).not.toHaveBeenCalled();
  });

  test("不带 @ 的原串同样命中", async () => {
    await handleIncomingMessageMiddleware(groupMessage("怎么入群？"));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("文本对不上就照常进 AI，不被直答吞掉", async () => {
    await handleIncomingMessageMiddleware(mentioning("入群要怎么弄呀"));

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(1);
  });

  test("没 /init enable 的群不直答——即使热表里有这条问答", async () => {
    autoMessageChatState.isInitEnabled = false;

    await handleIncomingMessageMiddleware(mentioning("怎么入群？"));

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(1);
  });

  test("本群没登记过问答时整条判定走开，照常进 AI", async () => {
    autoMessageQaEntries.clear();

    await handleIncomingMessageMiddleware(mentioning("怎么入群？"));

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(1);
  });
});
