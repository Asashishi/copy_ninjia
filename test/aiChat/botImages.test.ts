import { beforeEach, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";

let aiActive: boolean = true;
let copyTarget: number | undefined = undefined;
const recordChatMessage = mock((..._args: unknown[]): void => {});
const logError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/aiChat/availability", () => ({ isAiChatActiveIn: (): boolean => aiActive }));
mock.module("../../packages/aiChat/messageIngress", () => ({ recordChatMessage }));
mock.module("../../packages/infra/storage/stateStore", () => ({ activeCopyTargetIdIn: (): number | undefined => copyTarget }));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: logError }) }));

const { recordBotImage } = await import("../../packages/aiChat/botImages");

beforeEach(() => {
  aiActive = true;
  copyTarget = undefined;
  recordChatMessage.mockReset();
  logError.mockClear();
});

test("本群正跑 AI 闲聊时投递一条现造的占位自录", () => {
  recordBotImage({ chatId: -1001, messageId: 5, caption: "图注", edited: true });
  expect(recordChatMessage).toHaveBeenCalledWith({
    type: "recordBotImage",
    chatId: -1001,
    messageId: 5,
    caption: "图注",
    edited: true,
    persistImmediately: false,
  });
});

test("AI 闲聊关闭或本群有复读目标时不投递", () => {
  aiActive = false;
  recordBotImage({ chatId: -1001, messageId: 5, caption: "", edited: false });
  aiActive = true;
  copyTarget = 7;
  recordBotImage({ chatId: -1001, messageId: 6, caption: "", edited: false });
  expect(recordChatMessage).not.toHaveBeenCalled();
});

test("AI Worker 不可用时只记错误日志，不把异常抛回发送路径", () => {
  recordChatMessage.mockImplementationOnce((): void => {
    throw new Error("AI Worker is unavailable.");
  });
  expect((): void => recordBotImage({ chatId: -1001, messageId: 5, caption: "", edited: false })).not.toThrow();
  expect(logError).toHaveBeenCalledTimes(1);
  expect(String(logError.mock.calls[0]?.[0])).toContain("Failed to record bot image 5 in AI memory (chat -1001)");
});
