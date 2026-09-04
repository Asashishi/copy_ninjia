import { describe, expect, test } from "bun:test";
import { aiReplyReferenceFixture } from "../helpers/aiMemoryFixtures";
import type { Animation, Message, MessageEntity, PhotoSize } from "grammy/types";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../packages/consts/aiChat/media";
import type { MentionFacts } from "../../packages/types/auto";
import {
  hasCopyableContent,
  isReplyToSelf,
  pickAnimationVisionSource,
  pickPhotoFile,
  resolveForwardOrigin,
  resolveMentionFacts,
  resolveReplyReference,
  resolveSpeaker,
} from "../../packages/auto/message/facts";

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
    expect(resolveMentionFacts(message({
      text: "Hi @Test_Bot",
      entities: [{ type: "mention", offset: 3, length: 9 }],
    }), 999, "test_bot").isMentioned).toBe(true);

    expect(resolveMentionFacts(message({
      caption: "看 @test_bot",
      caption_entities: [{ type: "mention", offset: 2, length: 9 }],
    }), 999, "test_bot").isMentioned).toBe(true);

    expect(resolveMentionFacts(message({
      text: "找 Bob",
      entities: [{ type: "text_mention", offset: 2, length: 3, user: { id: 456, is_bot: false, first_name: "Bob" } }],
    }), 999, "test_bot").hasOtherMention).toBe(true);
    expect(resolveMentionFacts(message({
      text: "找 bot",
      entities: [{ type: "text_mention", offset: 2, length: 3, user: { id: 999, is_bot: true, first_name: "Bot" } }],
    }), 999, "test_bot").hasOtherMention).toBe(false);
  });

  /**
   * 长度前置筛选与「先比长度再物化子串」的收口，必须与「整串折小写后逐字比对
   * `@用户名`」同解。这里拿参考实现穷举对拍：正文形态 × 实体偏移 × 实体长度 ×
   * 机器人用户名，含**越界实体**（负偏移、越过正文末尾）与 İ/Σ/ß/K 这些折小写
   * 会变长、或非 ASCII 折成 ASCII 的字符。
   *
   * 越界那一组是承重的：`substring` 会把越界实体夹短，此时 `entity.length` 不再
   * 等于真正参与比对的长度，只按它筛就会把一条本该命中的提及判成别人——那等于
   * @ 机器人静默失效。
   */
  test("提及判定与「整串折小写比对」参考实现在畸形实体上同解", () => {
    const reference = (
      target: Message,
      botId: number,
      botUsername: string | undefined
    ): MentionFacts => {
      const facts: MentionFacts = { isMentioned: false, hasOtherMention: false };
      const text: string | undefined = typeof target.text === "string" && target.entities
        ? target.text
        : typeof target.caption === "string" && target.caption_entities
          ? target.caption
          : undefined;
      const entities: readonly MessageEntity[] | undefined = typeof target.text === "string" && target.entities
        ? target.entities
        : target.caption_entities;
      if (text === undefined || entities === undefined) return facts;
      const botTarget: string | undefined = botUsername ? `@${botUsername}`.toLowerCase() : undefined;
      for (const entity of entities) {
        if (entity.type === "mention") {
          const mentionText: string = text
            .substring(entity.offset, entity.offset + entity.length)
            .toLowerCase();
          if (botTarget !== undefined && mentionText === botTarget) facts.isMentioned = true;
          else facts.hasOtherMention = true;
        } else if (entity.type === "text_mention" && entity.user.id !== botId) {
          facts.hasOtherMention = true;
        }
      }
      return facts;
    };

    const texts: readonly string[] = [
      "", "@bot", "@Bot", "hi @bot", "hi @bot bye", "@bot @bot", "@other",
      "@BOT", "@bot2", "@bo", "x@bot", "İot", "@İot", "@Σ", "@Kot", "@ß",
    ];
    const usernames: readonly (string | undefined)[] = [
      undefined, "", "bot", "Bot", "BOT", "b", "İot", "Σ", "Kot", "ß",
    ];
    const offsets: readonly number[] = [-3, -1, 0, 1, 2, 4, 8, 100];
    const lengths: readonly number[] = [0, 1, 2, 3, 4, 5, 9, 100];

    let mismatch: string = "";
    let checked: number = 0;
    for (const text of texts) {
      for (const offset of offsets) {
        for (const length of lengths) {
          const entities = [
            { type: "mention", offset, length },
            { type: "mention", offset: 0, length: 4 },
            { type: "text_mention", offset: 0, length: 1, user: { id: 999, is_bot: false, first_name: "B" } },
            { type: "text_mention", offset: 0, length: 1, user: { id: 7, is_bot: false, first_name: "C" } },
          ];
          for (const shaped of [
            message({ text, entities }),
            message({ caption: text, caption_entities: entities }),
          ]) {
            for (const botUsername of usernames) {
              const expected: MentionFacts = reference(shaped, 999, botUsername);
              const actual: MentionFacts = resolveMentionFacts(shaped, 999, botUsername);
              checked += 1;
              if (
                mismatch === "" &&
                (expected.isMentioned !== actual.isMentioned ||
                  expected.hasOtherMention !== actual.hasOtherMention)
              ) {
                mismatch = `text=${JSON.stringify(text)} offset=${offset} length=${length} ` +
                  `bot=${JSON.stringify(botUsername)} expected=${JSON.stringify(expected)} ` +
                  `actual=${JSON.stringify(actual)}`;
              }
            }
          }
        }
      }
    }
    expect(mismatch).toBe("");
    expect(checked).toBe(20480);
  });

  /**
   * 长度前置筛选（见 resolveMentionFacts）成立的唯一前提：折小写不会让字符串
   * 变短。逐码元核对全 BMP——一旦某个运行时给出会缩短的映射，比目标长的 mention
   * 就可能折成目标本身，而前置筛选会把它当成别人，@ 机器人静默失效。
   */
  test("折小写不缩短长度：mention 长度前置筛选的前提", () => {
    let shrinking: number = 0;
    let growing: number = 0;
    for (let code: number = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const source: string = String.fromCharCode(code);
      const lowered: number = source.toLowerCase().length;
      if (lowered < source.length) shrinking += 1;
      else if (lowered > source.length) growing += 1;
    }
    expect(shrinking).toBe(0);
    // 唯一会变长的是 U+0130（İ → i + U+0307）。
    expect(growing).toBe(1);
    expect("İ".toLowerCase().length).toBe(2);
  });

  test("mention 只在与 @用户名 逐字相等时算点名本机器人", () => {
    // 比目标长：前置筛选直接判成别人。
    expect(resolveMentionFacts(message({
      text: "Hi @test_bot_2",
      entities: [{ type: "mention", offset: 3, length: 11 }],
    }), 999, "test_bot")).toEqual({ isMentioned: false, hasOtherMention: true });
    // 比目标短：物化后长度对不上，同样是别人。
    expect(resolveMentionFacts(message({
      text: "Hi @test_bo",
      entities: [{ type: "mention", offset: 3, length: 8 }],
    }), 999, "test_bot")).toEqual({ isMentioned: false, hasOtherMention: true });
    // 只是后缀相同、缺了 @：不算。
    expect(resolveMentionFacts(message({
      text: "Hi xtest_bot",
      entities: [{ type: "mention", offset: 3, length: 9 }],
    }), 999, "test_bot")).toEqual({ isMentioned: false, hasOtherMention: true });
    // 机器人自己的用户名带大写时也要认得出来。
    expect(resolveMentionFacts(message({
      text: "Hi @test_bot",
      entities: [{ type: "mention", offset: 3, length: 9 }],
    }), 999, "Test_Bot")).toEqual({ isMentioned: true, hasOtherMention: false });
    // 同一条里点名两次仍只记 isMentioned，不因第二次落进 hasOtherMention。
    expect(resolveMentionFacts(message({
      text: "@test_bot @test_bot",
      entities: [
        { type: "mention", offset: 0, length: 9 },
        { type: "mention", offset: 10, length: 9 },
      ],
    }), 999, "test_bot")).toEqual({ isMentioned: true, hasOtherMention: false });
    // 没有用户名时任何 mention 都算别人。
    expect(resolveMentionFacts(message({
      text: "Hi @test_bot",
      entities: [{ type: "mention", offset: 3, length: 9 }],
    }), 999, undefined)).toEqual({ isMentioned: false, hasOtherMention: true });
    expect(resolveMentionFacts(message({
      text: "Hi @test_bot",
      entities: [{ type: "mention", offset: 3, length: 9 }],
    }), 999, "")).toEqual({ isMentioned: false, hasOtherMention: true });
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

  test("回复引用保留原发送者、原文和 Telegram 选中的精确片段", () => {
    expect(resolveReplyReference(message({
      text: "@test_bot 这句呢",
      reply_to_message: message({
        message_id: 40,
        from: { id: 456, is_bot: false, first_name: "Bob", username: "bob_dev" },
        text: "第一句\n第二句",
      }),
      quote: { text: "第二句", position: 4, is_manual: true },
    }))).toEqual(aiReplyReferenceFixture({
      messageId: 40,
      id: 456,
      firstName: "Bob",
      lastName: "",
      username: "bob_dev",
      text: "第一句\n第二句",
      quote: "第二句",
    }));

    expect(resolveReplyReference(message({
      reply_to_message: message({
        message_id: 41,
        photo: [{ file_id: "photo", file_unique_id: "photo-u", width: 10, height: 10 }],
        caption: "看这里",
      }),
    }))?.text).toBe("[图片] 看这里");
  });

  test("resolveForwardOrigin 覆盖四种转发来源，非转发返回 undefined", () => {
    expect(resolveForwardOrigin(message())).toBeUndefined();
    // 关联频道帖自动转进讨论组：发言人已是频道本身，不再标「转发自」。
    expect(resolveForwardOrigin(message({
      is_automatic_forward: true,
      sender_chat: { id: -100666, type: "channel", title: "东京日报", username: "tokyo_daily" },
      forward_origin: {
        type: "channel",
        date: 1,
        chat: { id: -100666, type: "channel", title: "东京日报", username: "tokyo_daily" },
        message_id: 9,
      },
    }))).toBeUndefined();
    expect(resolveForwardOrigin(message({
      forward_origin: {
        type: "user",
        date: 1,
        sender_user: { id: 789, is_bot: false, first_name: "Carol", last_name: "Chan", username: "carol_cc" },
      },
    }))).toBe("[id:789] [username:@carol_cc] Carol Chan");
    expect(resolveForwardOrigin(message({
      forward_origin: { type: "hidden_user", date: 1, sender_user_name: "神秘人" },
    }))).toBe("神秘人");
    expect(resolveForwardOrigin(message({
      forward_origin: {
        type: "chat",
        date: 1,
        sender_chat: { id: -100777, type: "supergroup", title: "隔壁群" },
      },
    }))).toBe("[id:-100777] 隔壁群");
    expect(resolveForwardOrigin(message({
      forward_origin: {
        type: "channel",
        date: 1,
        chat: { id: -100666, type: "channel", title: "东京日报", username: "tokyo_daily" },
        message_id: 9,
      },
    }))).toBe("频道 [id:-100666] [username:@tokyo_daily] 东京日报");
  });

  test("被回复的消息是转发时，回复引用带上转发来源标注", () => {
    expect(resolveReplyReference(message({
      text: "@test_bot 你怎么看这条",
      reply_to_message: message({
        message_id: 42,
        from: { id: 456, is_bot: false, first_name: "Bob", username: "bob_dev" },
        forward_origin: { type: "hidden_user", date: 1, sender_user_name: "神秘人" },
        text: "转来的爆料",
      }),
    }))).toEqual(aiReplyReferenceFixture({
      messageId: 42,
      id: 456,
      firstName: "Bob",
      lastName: "",
      username: "bob_dev",
      text: "转来的爆料",
      forwardedFrom: "神秘人",
    }));
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
