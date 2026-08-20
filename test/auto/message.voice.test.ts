/**
 * 语音消息的准入与记录（见 packages/auto/message/voice.ts）。
 *
 * 两条上限（时长、声明体积）在**下载之前**就拦掉：那道下载侧的字节闸要先把整段
 * 音频拉下来才知道超限，一条一小时的语音会白占一个媒体执行槽和整段带宽，最后
 * 仍然只换来一行兜底占位。被拦下的语音退回一行带时长的纯文本，直接触发时照样
 * 回一句——真人在等回应，「已读不回」比回一句「太长了没听」更糟。
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { aiRecordMediaMessageFixture, aiRecordMessageFixture } from "../helpers/aiMemoryFixtures";
// 六个公共模块桩收在 helper 里（见 test/helpers/autoMessageMocks.ts）；
// 必须在下面的 await import 之前登记。
import {
  generateAndSendReplyMock,
  recordChatMediaMock,
  recordChatMessageMock,
  resetAutoMessageMocks,
} from "../helpers/autoMessageMocks";

const { handleIncomingMessage } = await import("../../packages/auto/message");
const { clearAiReplyActivity } = await import("../../packages/auto/message/aiReplyActivity");
const { clearUserReplyTriggerTimes } = await import("../../packages/auto/message/triggerPolicy");
const {
  VOICE_MAX_DOWNLOAD_BYTES,
  VOICE_MAX_DURATION_SECONDS,
} = await import("../../packages/consts/aiChat/voice");

const botInfo = { id: 999_999, username: "test_bot", first_name: "TestBot" };
const chat = { id: -100_1, type: "supergroup", title: "Test Group" };
const alice = { id: 100, is_bot: false, username: undefined, first_name: "杂鱼", last_name: "" };
const botReply = {
  message_id: 50,
  date: 1,
  chat,
  from: { id: botInfo.id, is_bot: true, first_name: "TestBot", username: "test_bot" },
  text: "机器人之前说的话",
};

/** 一条默认 12 秒、直接回复机器人的语音消息。 */
function voiceMessage(voice: Record<string, unknown>, replyToBot: boolean = true): unknown {
  return {
    me: botInfo,
    msg: {
      message_id: 1,
      date: 1,
      chat,
      from: alice,
      ...(replyToBot ? { reply_to_message: botReply } : {}),
      voice: { file_id: "voice-file", file_unique_id: "unique", duration: 12, mime_type: "audio/ogg", ...voice },
    },
  };
}

describe("群聊语音消息", () => {
  beforeEach(() => {
    resetAutoMessageMocks();
    clearUserReplyTriggerTimes();
    clearAiReplyActivity();
  });

  afterAll((): void => {
    clearUserReplyTriggerTimes();
    clearAiReplyActivity();
  });

  test("可转写的语音走媒体管线，两个尺寸字段恒为 0，容器与时长原样带上", async () => {
    await handleIncomingMessage(voiceMessage({}) as any);

    expect(recordChatMediaMock).toHaveBeenCalledTimes(1);
    const payload = recordChatMediaMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "recordMedia",
      kind: "voice",
      fileId: "voice-file",
      fileUniqueId: "unique",
      width: 0,
      height: 0,
      voiceMime: "audio/ogg",
      voiceDurationSeconds: 12,
      stickerFallbackText: undefined,
      directTriggerReason: "reply",
    });
    // 语音不作为生图参考素材，但直接触发仍开放重媒体工具资格。
    expect(payload.imageGenerationRequested).toBe(true);
    expect(recordChatMessageMock).not.toHaveBeenCalled();
  });

  test("caption 原样进媒体载荷", async () => {
    await handleIncomingMessage({
      ...(voiceMessage({}) as any),
      msg: { ...(voiceMessage({}) as any).msg, caption: "听听这个" },
    } as any);

    expect((recordChatMediaMock.mock.calls[0]![0] as { caption: string }).caption).toBe("听听这个");
  });

  test("超时长的语音退回带时长的纯文本，不进转写管线", async () => {
    await handleIncomingMessage(voiceMessage({ duration: VOICE_MAX_DURATION_SECONDS + 1 }) as any);

    expect(recordChatMediaMock).not.toHaveBeenCalled();
    expect(recordChatMessageMock).toHaveBeenCalledWith(aiRecordMessageFixture({
      text: `[语音 ${VOICE_MAX_DURATION_SECONDS + 1} 秒]`,
      replyTo: expect.anything(),
    }));
    // 真人在等回应：拦下的是转写，不是回复。
    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(1);
  });

  test("声明体积超上限的语音同样在下载前拦下", async () => {
    await handleIncomingMessage(voiceMessage({ file_size: VOICE_MAX_DOWNLOAD_BYTES + 1 }) as any);

    expect(recordChatMediaMock).not.toHaveBeenCalled();
    expect((recordChatMessageMock.mock.calls[0]![0] as { text: string }).text).toBe("[语音 12 秒]");
  });

  test("缺 file_size 时只按时长判，仍照常转写", async () => {
    await handleIncomingMessage(voiceMessage({ file_size: undefined }) as any);

    expect(recordChatMediaMock).toHaveBeenCalledTimes(1);
    expect(recordChatMessageMock).not.toHaveBeenCalled();
  });

  test("超长语音且没人叫机器人时只记一行，不触发回复", async () => {
    await handleIncomingMessage(
      voiceMessage({ duration: VOICE_MAX_DURATION_SECONDS + 1 }, false) as any
    );

    expect(recordChatMessageMock).toHaveBeenCalledTimes(1);
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("退回纯文本时 caption 跟在时长标签后面", async () => {
    const base = voiceMessage({ duration: VOICE_MAX_DURATION_SECONDS + 1 }) as any;
    await handleIncomingMessage({ ...base, msg: { ...base.msg, caption: "很长的一段" } } as any);

    expect((recordChatMessageMock.mock.calls[0]![0] as { text: string }).text)
      .toBe(`[语音 ${VOICE_MAX_DURATION_SECONDS + 1} 秒] 很长的一段`);
  });

  test("媒体夹具的默认形状与语音载荷共享同一组必填键", () => {
    // 协议形状必须保持单一隐藏类：语音那两个字段在其余媒体上也要写出来。
    expect(aiRecordMediaMessageFixture()).toMatchObject({ voiceMime: undefined, voiceDurationSeconds: 0 });
  });
});
