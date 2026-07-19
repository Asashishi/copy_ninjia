import { describe, expect, test } from "bun:test";
import type { Animation, Message, PhotoSize } from "@grammyjs/types";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../src/consts/aiChat";
import {
  hasCopyableContent,
  isBotMentioned,
  isReplyToSelf,
  mentionsOtherUser,
  pickAnimationVisionSource,
  pickPhotoFile,
  resolveSpeaker,
} from "../../src/auto/message/facts";

const chat = { id: -100800, type: "supergroup", title: "Test Group" } as const;
const alice = { id: 123, is_bot: false, first_name: "Alice", last_name: "Tester", username: "alice_dev" } as const;

function message(overrides: Record<string, unknown> = {}): Message {
  return {
    message_id: 1,
    date: 1,
    chat,
    from: alice,
    ...overrides,
  } as unknown as Message;
}

describe("auto/message/facts", () => {
  test("resolveSpeaker 优先使用 sender_chat，并让频道帖退回频道身份", () => {
    expect(resolveSpeaker(message())).toEqual({
      id: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
    });

    expect(resolveSpeaker(message({
      sender_chat: { id: -100900, type: "channel", title: "Mask", username: "mask_channel" },
    }))).toEqual({ id: -100900, firstName: "Mask", lastName: "", username: "mask_channel" });

    expect(resolveSpeaker(message({
      chat: { id: -100901, type: "channel", title: "News", username: "news" },
      from: undefined,
    }))).toEqual({ id: -100901, firstName: "News", lastName: "", username: "news" });
  });

  test("mention 判定同时覆盖文本、caption、大小写与 text_mention", () => {
    expect(isBotMentioned(message({
      text: "Hi @Test_Bot",
      entities: [{ type: "mention", offset: 3, length: 9 }],
    }), "test_bot")).toBe(true);

    expect(isBotMentioned(message({
      caption: "看 @test_bot",
      caption_entities: [{ type: "mention", offset: 2, length: 9 }],
    }), "test_bot")).toBe(true);

    expect(mentionsOtherUser(message({
      text: "找 Bob",
      entities: [{ type: "text_mention", offset: 2, length: 3, user: { id: 456, is_bot: false, first_name: "Bob" } }],
    }), 999, "test_bot")).toBe(true);
    expect(mentionsOtherUser(message({
      text: "找 bot",
      entities: [{ type: "text_mention", offset: 2, length: 3, user: { id: 999, is_bot: true, first_name: "Bot" } }],
    }), 999, "test_bot")).toBe(false);
  });

  test("自回复按可见发送身份判断，身份缺失或回复别人时不误判", () => {
    expect(isReplyToSelf(message({ reply_to_message: message({ message_id: 2 }) }))).toBe(true);
    expect(isReplyToSelf(message({
      reply_to_message: message({ message_id: 2, from: { id: 456, is_bot: false, first_name: "Bob" } }),
    }))).toBe(false);

    const anonymousSender = { id: -100800, type: "supergroup", title: "Test Group" };
    expect(isReplyToSelf(message({
      sender_chat: anonymousSender,
      reply_to_message: message({ message_id: 2, sender_chat: anonymousSender }),
    }))).toBe(true);
    expect(isReplyToSelf(message({ from: undefined, reply_to_message: message({ message_id: 2, from: undefined }) }))).toBe(false);
  });

  test("图片档位选最大未超限项，全超限时退回最小档", () => {
    const sizes = [
      { file_id: "small", file_unique_id: "small-u", width: 100, height: 100, file_size: 100 },
      { file_id: "middle", file_unique_id: "middle-u", width: 500, height: 500, file_size: MEDIA_MAX_DOWNLOAD_BYTES },
      { file_id: "large", file_unique_id: "large-u", width: 1000, height: 1000, file_size: MEDIA_MAX_DOWNLOAD_BYTES + 1 },
    ] as PhotoSize[];
    expect(pickPhotoFile(sizes)).toEqual({ fileId: "middle", fileUniqueId: "middle-u", width: 500, height: 500 });
    expect(pickPhotoFile(sizes.map((size) => ({ ...size, file_size: MEDIA_MAX_DOWNLOAD_BYTES + 1 })))).toEqual({
      fileId: "small",
      fileUniqueId: "small-u",
      width: 100,
      height: 100,
    });
    expect(pickPhotoFile([...sizes, { file_id: "unknown", file_unique_id: "unknown-u", width: 1200, height: 1200 }])).toEqual({
      fileId: "unknown",
      fileUniqueId: "unknown-u",
      width: 1200,
      height: 1200,
    });
  });

  test("GIF 只使用缩略图，缓存键保持 animation 自身唯一 id", () => {
    const animation = {
      file_id: "animation-file",
      file_unique_id: "animation-uid",
      width: 640,
      height: 480,
      duration: 2,
      thumbnail: { file_id: "thumb", file_unique_id: "thumb-uid", width: 320, height: 240 },
    } as Animation;
    expect(pickAnimationVisionSource(animation)).toEqual({
      fileId: "thumb",
      fileUniqueId: "animation-uid",
      width: 320,
      height: 240,
    });
    expect(pickAnimationVisionSource({ ...animation, thumbnail: undefined })).toBeNull();
  });

  test("随机复读只接收有实际载荷的消息", () => {
    expect(hasCopyableContent(message({ text: "hello" }))).toBe(true);
    expect(hasCopyableContent(message({ photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }] }))).toBe(true);
    expect(hasCopyableContent(message({ new_chat_members: [alice] }))).toBe(false);
  });
});
