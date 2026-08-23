/** gag 的消息 ingress 与 inline 入口协议。 */

import { describe, expect, test } from "bun:test";
import type {
  Message,
  MessageEntity,
} from "@grammyjs/types";
import {
  GAG_SESSION_MAX,
  GAG_SPEAK_NOTICE_MESSAGE_INTERVAL,
} from "../../packages/consts/gag";
import { GAG_THUMBNAIL_URL } from "../../packages/consts/ui/assets";
import type { GagSession } from "../../packages/types/gag";
import { inlineResultSourceOf } from "../../packages/infra/inlineResultSources";
import { settleTestBatch } from "../libs/helpers";
import {
  addSession,
  answerInlineQuery,
  commandContext,
  createSession,
  deleteEphemeralMessageWithOutcome,
  deleteMessageWithOutcome,
  gagInlineEntities,
  gagSessionsByChat,
  lastCommandText,
  normalMessage,
  rendering,
  sendEphemeralMessage,
  sendMessage,
  sessionFor,
  settleGagBackgroundTasks,
  installGagTestHooks,
} from "../helpers/gagHarness";
import type {
  EphemeralDeletionParams,
  EphemeralMessageParams,
  InlineAnswerOptions,
  InlineResult,
  TextMessageParams,
} from "../helpers/gagHarness";

const gag = await import("../../packages/commands/gag");

installGagTestHooks();

describe("gag 消息与 inline 入口", () => {
  test("被管教的人换个话题说话：入口搬到新话题，旧话题那条被删掉", async () => {
    // 按钮留在原话题的话，他在话题 B 被删消息、却要回话题 A 才能说话。
    const session: GagSession = createSession({
      targetId: 7,
      speakNoticeMessageId: 55,
      speakNoticeThreadId: 11,
    });
    addSession(session);
    const events: string[] = [];
    sendEphemeralMessage.mockImplementation(
      async (params: EphemeralMessageParams): Promise<number> => {
        events.push(`send:${String(params.messageThreadId)}`);
        params.onSent?.(56);
        return 56;
      }
    );
    deleteEphemeralMessageWithOutcome.mockImplementation(
      async (params: EphemeralDeletionParams): Promise<string> => {
        events.push(`delete:${params.ephemeralMessageId}`);
        return "deleted";
      }
    );

    const claimed: boolean = await gag.handleGagMessageIngress(
      normalMessage({ message_thread_id: 22, is_topic_message: true }),
      1
    );
    await settleGagBackgroundTasks();

    expect(claimed).toBe(true);
    // 先在新话题发一条，再删旧话题那条；顺序反过来会出现一段没有入口的空窗。
    expect(events).toEqual(["send:22", "delete:55"]);
    expect(session.speakNoticeThreadId).toBe(22);
    expect(session.speakNoticeMessageId).toBe(56);
    expect(session.retiredSpeakNoticeMessageId).toBe(0);
  });

  test("同一话题内说话不搬家，滚动换新仍留在原话题", async () => {
    const session: GagSession = createSession({
      targetId: 7,
      speakNoticeMessageId: 55,
      speakNoticeThreadId: 11,
      messagesSinceSpeakNotice: GAG_SPEAK_NOTICE_MESSAGE_INTERVAL - 1,
    });
    addSession(session);
    const threads: (number | undefined)[] = [];
    sendEphemeralMessage.mockImplementation(
      async (params: EphemeralMessageParams): Promise<number> => {
        threads.push(params.messageThreadId);
        params.onSent?.(57);
        return 57;
      }
    );

    // 目标自己的消息会被 gag 删掉，因此不进 15 条窗口；换新由别人的消息推动。
    await gag.handleGagMessageIngress(
      normalMessage({
        message_id: 90,
        from: { id: 8, is_bot: false, first_name: "Bob" },
        message_thread_id: 11,
        is_topic_message: true,
      }),
      1
    );
    await settleGagBackgroundTasks();

    expect(threads).toEqual([11]);
    expect(session.speakNoticeThreadId).toBe(11);
  });

  test("非论坛群不会因为话题判定而触发搬家", async () => {
    const session: GagSession = createSession({
      targetId: 7,
      speakNoticeMessageId: 55,
    });
    addSession(session);
    sendEphemeralMessage.mockImplementation(
      async (params: EphemeralMessageParams): Promise<number> => {
        params.onSent?.(58);
        return 58;
      }
    );

    await gag.handleGagMessageIngress(normalMessage(), 1);
    await settleGagBackgroundTasks();

    expect(sendEphemeralMessage).not.toHaveBeenCalled();
    expect(session.speakNoticeThreadId).toBeUndefined();
  });

  test("多个用户和频道会话按各自入口起点每 15 条换新，且先发新入口再删本会话旧入口", async () => {
    const userSession: GagSession = createSession({
      targetId: 7,
      messagesSinceSpeakNotice: 0,
    });
    const channelSession: GagSession = createSession({
      targetId: -1002233445566,
      speakNoticeMessageId: 66,
      messagesSinceSpeakNotice: 5,
    });
    addSession(userSession);
    addSession(channelSession);
    const events: string[] = [];
    sendMessage.mockImplementation(async (params: TextMessageParams): Promise<number> => {
      events.push("send-channel-76");
      params.onSent?.(76);
      return 76;
    });
    sendEphemeralMessage.mockImplementation(async (
      params: EphemeralMessageParams
    ): Promise<number> => {
      events.push("send-user-75");
      params.onSent?.(75);
      return 75;
    });
    deleteMessageWithOutcome.mockImplementation(async (
      _chatId: number,
      messageId: number
    ): Promise<string> => {
      events.push(`delete-channel-${messageId}`);
      return "deleted";
    });
    deleteEphemeralMessageWithOutcome.mockImplementation(async (
      params: EphemeralDeletionParams
    ): Promise<string> => {
      events.push(`delete-user-${params.ephemeralMessageId}`);
      return "deleted";
    });

    for (let index: number = 0; index < 10; index++) {
      expect(await gag.handleGagMessageIngress(normalMessage({
        message_id: 100 + index,
        from: { id: 100, is_bot: false, first_name: "Admin" },
      }), 999)).toBeFalse();
    }
    await settleGagBackgroundTasks();
    expect(channelSession.speakNoticeMessageId).toBe(76);
    expect(channelSession.messagesSinceSpeakNotice).toBe(0);
    expect(userSession.speakNoticeMessageId).toBe(55);
    expect(userSession.messagesSinceSpeakNotice).toBe(10);
    expect(events).toEqual(["send-channel-76", "delete-channel-66"]);

    for (let index: number = 10; index < GAG_SPEAK_NOTICE_MESSAGE_INTERVAL; index++) {
      expect(await gag.handleGagMessageIngress(normalMessage({
        message_id: 100 + index,
        from: { id: 100, is_bot: false, first_name: "Admin" },
      }), 999)).toBeFalse();
    }
    await settleGagBackgroundTasks();
    expect(userSession.speakNoticeMessageId).toBe(75);
    expect(userSession.messagesSinceSpeakNotice).toBe(0);
    expect(channelSession.messagesSinceSpeakNotice).toBe(5);
    expect(events).toEqual([
      "send-channel-76",
      "delete-channel-66",
      "send-user-75",
      "delete-user-55",
    ]);
    expect(deleteMessageWithOutcome).not.toHaveBeenCalledWith(-1001, 54);
    expect(userSession.retiredSpeakNoticeMessageId).toBe(0);
    expect(channelSession.retiredSpeakNoticeMessageId).toBe(0);
  });

  test("旧入口删除连续失败时只保留一个 retired 槽，并按每 15 条而非每条消息重试", async () => {
    const session: GagSession = createSession({
      messagesSinceSpeakNotice: GAG_SPEAK_NOTICE_MESSAGE_INTERVAL - 1,
    });
    addSession(session);
    let nextNoticeId: number = 75;
    sendEphemeralMessage.mockImplementation(async (
      params: EphemeralMessageParams
    ): Promise<number> => {
      const noticeId: number = nextNoticeId++;
      params.onSent?.(noticeId);
      return noticeId;
    });
    let deleteAttempt: number = 0;
    deleteEphemeralMessageWithOutcome.mockImplementation(async (): Promise<string> => {
      deleteAttempt++;
      return deleteAttempt <= 2 ? "failed" : "deleted";
    });

    await gag.handleGagMessageIngress(normalMessage({
      from: { id: 100, is_bot: false, first_name: "Admin" },
    }), 999);
    await settleGagBackgroundTasks();
    expect(session.speakNoticeMessageId).toBe(75);
    expect(session.retiredSpeakNoticeMessageId).toBe(55);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(1);

    for (let index: number = 0; index < GAG_SPEAK_NOTICE_MESSAGE_INTERVAL; index++) {
      await gag.handleGagMessageIngress(normalMessage({
        message_id: 200 + index,
        from: { id: 100, is_bot: false, first_name: "Admin" },
      }), 999);
    }
    await settleGagBackgroundTasks();
    expect(session.speakNoticeMessageId).toBe(75);
    expect(session.retiredSpeakNoticeMessageId).toBe(55);
    expect(session.messagesSinceSpeakNotice).toBe(0);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(2);

    for (let index: number = 0; index < GAG_SPEAK_NOTICE_MESSAGE_INTERVAL; index++) {
      await gag.handleGagMessageIngress(normalMessage({
        message_id: 300 + index,
        from: { id: 100, is_bot: false, first_name: "Admin" },
      }), 999);
    }
    await settleGagBackgroundTasks();
    expect(session.speakNoticeMessageId).toBe(76);
    expect(session.retiredSpeakNoticeMessageId).toBe(0);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(4);
  });

  test("结束一个 gag 只删除该目标的公开状态和精确接收者入口", async () => {
    const first: GagSession = createSession({ targetId: 7 });
    const second: GagSession = createSession({
      targetId: 8,
      publicNoticeMessageId: 64,
      // ephemeral id 可以与另一接收者相同，删除仍必须由 receiver id 隔离。
      speakNoticeMessageId: 55,
    });
    const channel: GagSession = createSession({
      targetId: -1002233445566,
      speakNoticeMessageId: 74,
    });
    addSession(first);
    addSession(second);
    addSession(channel);

    await gag.handleUngagCommand(commandContext({ match: "7" }));

    expect(sessionFor(-1001, 7)).toBeUndefined();
    expect(sessionFor(-1001, 8)).toBe(second);
    expect(sessionFor(-1001, -1002233445566)).toBe(channel);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
  });

  test("入口换新与 teardown 交错时清理旧入口和已送达的新入口，不泄漏也不复活", async () => {
    const session: GagSession = createSession({
      messagesSinceSpeakNotice: GAG_SPEAK_NOTICE_MESSAGE_INTERVAL - 1,
    });
    addSession(session);
    let finishSend: (() => void) | undefined;
    sendEphemeralMessage.mockImplementationOnce((
      params: EphemeralMessageParams
    ): Promise<number> => new Promise<number>(
      (resolve: (messageId: number) => void): void => {
        finishSend = (): void => {
          params.onSent?.(77);
          resolve(77);
        };
      }
    ));

    const ingress: Promise<boolean> = gag.handleGagMessageIngress(
      normalMessage({
        from: { id: 100, is_bot: false, first_name: "Admin" },
      }),
      999
    );
    for (let step: number = 0; step < 6 && finishSend === undefined; step++) {
      await Promise.resolve();
    }
    expect(finishSend).toBeDefined();
    const teardown: Promise<void> = gag.teardownGagInChat(session.chatId);
    await Promise.resolve();
    expect(session.phase).toBe("ending");

    finishSend!();
    const ingressDone: Promise<void> = ingress.then(
      (handled: boolean): void => expect(handled).toBeFalse()
    );
    await settleTestBatch([ingressDone, teardown]);

    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 77,
    });
  });

  test("目标直发且会删除的文字不计入 15 条，按钮发言与保留媒体才计数", async () => {
    const session: GagSession = createSession({
      messagesSinceSpeakNotice: GAG_SPEAK_NOTICE_MESSAGE_INTERVAL - 1,
    });
    const otherSession: GagSession = createSession({
      targetId: 8,
      publicNoticeMessageId: 64,
      speakNoticeMessageId: 65,
      messagesSinceSpeakNotice: 3,
    });
    addSession(session);
    addSession(otherSession);
    let nextNoticeId: number = 75;
    sendEphemeralMessage.mockImplementation(async (
      params: EphemeralMessageParams
    ): Promise<number> => {
      const noticeId: number = nextNoticeId++;
      params.onSent?.(noticeId);
      return noticeId;
    });

    expect(await gag.handleGagMessageIngress(normalMessage(), 999)).toBeTrue();
    expect(await gag.handleGagMessageIngress(normalMessage({
      text: undefined,
      photo: [{ file_id: "captioned-photo" }],
      caption: "会被删除的说明",
      message_id: 89,
    }), 999)).toBeTrue();
    expect(session.messagesSinceSpeakNotice).toBe(
      GAG_SPEAK_NOTICE_MESSAGE_INTERVAL - 1
    );
    expect(otherSession.messagesSinceSpeakNotice).toBe(3);
    expect(sendEphemeralMessage).not.toHaveBeenCalled();

    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）按钮发言",
      entities: gagInlineEntities(session),
    }), 999)).toBeFalse();
    await settleGagBackgroundTasks();
    expect(session.speakNoticeMessageId).toBe(75);
    expect(session.messagesSinceSpeakNotice).toBe(0);
    expect(otherSession.messagesSinceSpeakNotice).toBe(4);

    session.messagesSinceSpeakNotice = GAG_SPEAK_NOTICE_MESSAGE_INTERVAL - 1;
    expect(await gag.handleGagMessageIngress(normalMessage({
      text: undefined,
      photo: [{ file_id: "plain-photo" }],
      message_id: 90,
    }), 999)).toBeFalse();
    await settleGagBackgroundTasks();
    expect(session.speakNoticeMessageId).toBe(76);
    expect(session.messagesSinceSpeakNotice).toBe(0);
    expect(otherSession.messagesSinceSpeakNotice).toBe(5);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 75,
    });
  });

  test("gag 只删除纯文本和带 caption 的媒体，无文字媒体继续交给下游", async () => {
    addSession(createSession());

    expect(await gag.handleGagMessageIngress(normalMessage({
      text: undefined,
      sticker: { file_id: "sticker" },
    }), 999)).toBeFalse();
    expect(await gag.handleGagMessageIngress(normalMessage({
      text: undefined,
      photo: [{ file_id: "photo" }],
    }), 999)).toBeFalse();
    expect(await gag.handleGagMessageIngress(normalMessage({
      text: undefined,
      video: { file_id: "video" },
    }), 999)).toBeFalse();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();

    expect(await gag.handleGagMessageIngress(normalMessage({
      text: undefined,
      photo: [{ file_id: "photo" }],
      caption: "媒体说明",
      message_id: 89,
    }), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 89);
  });

  test("用户目标必须隐藏主页与群标记、当前 bot、用具和发送用户 id 同时匹配", async () => {
    const session: GagSession = createSession();
    addSession(session);

    expect(await gag.handleGagMessageIngress(normalMessage(), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeFalse();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();

    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过丝带）功... ",
    }), 999)).toBeTrue();

    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
    }), 999)).toBeTrue();

    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 998, is_bot: true, first_name: "Other" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeTrue();

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress(normalMessage({
      from: { id: 8, is_bot: false, first_name: "Bob" },
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);
  });

  test("频道目标必须主页与群标记、sender_chat.id 同时匹配，匿名服务用户不能覆盖", async () => {
    const session: GagSession = createSession({ targetId: -1002233445566 });
    addSession(session);
    const channelMessage: Message = normalMessage({
      sender_chat: {
        id: -1002233445566,
        type: "channel",
        title: "测试频道",
      },
      from: {
        id: 136817688,
        is_bot: true,
        first_name: "Channel",
      },
    });

    expect(await gag.handleGagMessageIngress(channelMessage, 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress({
      ...channelMessage,
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }, 999)).toBeFalse();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();

    const wrongMarker: MessageEntity[] = gagInlineEntities(createSession({
      targetId: -1009988776655,
    }));
    expect(await gag.handleGagMessageIngress({
      ...channelMessage,
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: wrongMarker,
    }, 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);

    deleteMessageWithOutcome.mockClear();
    const wrongGroupMarker: MessageEntity[] = gagInlineEntities(createSession({
      chatId: -1002,
      targetId: -1002233445566,
    }));
    expect(await gag.handleGagMessageIngress({
      ...channelMessage,
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: wrongGroupMarker,
    }, 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress(normalMessage({
      from: { id: 8, is_bot: false, first_name: "Bob" },
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress(normalMessage({
      sender_chat: {
        id: -1009988776655,
        type: "channel",
        title: "其它频道",
      },
      from: { id: 136817688, is_bot: true, first_name: "Channel" },
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);
  });

  test("本 bot 的过期或跨群 gag 标记在无活动会话时也会删除", async () => {
    const stale: GagSession = createSession({ targetId: -1002233445566 });
    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(stale),
    }), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);
  });

  test("到期消息先完成解除，再按正常消息交给下游", async () => {
    addSession(createSession({ expiresAt: 999_999 }));
    expect(await gag.handleGagMessageIngress(normalMessage(), 999)).toBeFalse();
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
    expect(lastCommandText()).toContain("时间到");
    expect(gagSessionsByChat.has(-1001)).toBeFalse();
  });

  test("普通 @ 查询只进入运势，按钮 gag 前缀仅向当前 gag 用户返回 gag", async () => {
    const session: GagSession = createSession();
    addSession(session);
    const handled: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-1",
        from: { id: 7, is_bot: false, first_name: "Alice" },
        query: `gag:${session.targetId} 功能没了喵`,
        offset: "",
      },
      answerInlineQuery,
    } as never);
    expect(handled).toBeTrue();
    const [results, options]: [readonly InlineResult[], InlineAnswerOptions, unknown?] =
      answerInlineQuery.mock.calls[0]!;
    expect(results).toHaveLength(1);
    expect(results[0]?.thumbnail_url).toBe(GAG_THUMBNAIL_URL);
    const content: { message_text: string; entities?: MessageEntity[] } =
      results[0]?.input_message_content as {
        message_text: string;
        entities?: MessageEntity[];
      };
    expect(content.message_text).toStartWith("（透过口塞）");
    expect(content.message_text.length).toBeGreaterThan(
      rendering.gagSpeechPrefix("口塞").length
    );
    expect(content.entities?.[0]).toEqual({
      type: "text_link",
      offset: 0,
      length: rendering.gagSpeechPrefix("口塞").length,
      url: "tg://user?id=7#-1001",
    });
    expect(options).toEqual({ cache_time: 0, is_personal: true });

    answerInlineQuery.mockClear();
    const gagUserOrdinaryQueryPassed: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-2",
        from: { id: 7, is_bot: false, first_name: "Alice" },
        query: "",
        offset: "",
      },
      answerInlineQuery,
    } as never);
    expect(gagUserOrdinaryQueryPassed).toBeFalse();
    expect(answerInlineQuery).not.toHaveBeenCalled();

    const otherUserOrdinaryQueryPassed: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-3",
        from: { id: 8, is_bot: false, first_name: "Bob" },
        query: "",
        offset: "",
      },
      answerInlineQuery,
    } as never);
    expect(otherUserOrdinaryQueryPassed).toBeFalse();
    expect(answerInlineQuery).not.toHaveBeenCalled();

    const copiedGagPrefixHandled: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-4",
        from: { id: 8, is_bot: false, first_name: "Bob" },
        query: `gag:${session.targetId} 偷来的入口`,
        offset: "",
      },
      answerInlineQuery,
    } as never);
    expect(copiedGagPrefixHandled).toBeTrue();
    expect(answerInlineQuery.mock.calls[0]?.[0]).toHaveLength(0);
  });

  test("每次应答登记本次全部结果的源文本，供广告检测按落群正文取回", async () => {
    // 送检的是这份源文本而不是变形正文；对应关系只有应答那一刻能建立。
    const userSession: GagSession = createSession();
    const otherChatSession: GagSession = createSession({ chatId: -1002 });
    addSession(userSession);
    addSession(otherChatSession);
    const renderQuery = async (
      text: string,
      id: string
    ): Promise<string[]> => {
      answerInlineQuery.mockClear();
      await gag.handleGagInlineQuery({
        inlineQuery: {
          id,
          from: { id: 7, is_bot: false, first_name: "Alice" },
          query: `gag:${userSession.targetId} ${text}`,
          offset: "",
        },
        answerInlineQuery,
      } as never);
      const [results]: [readonly InlineResult[], InlineAnswerOptions, unknown?] =
        answerInlineQuery.mock.calls[0]!;
      return results.map((result: InlineResult): string =>
        (result.input_message_content as { message_text: string }).message_text
      );
    };

    // 同一个人在两个群被 gag：一次查询给出两条结果，选中任意一条都要取得回。
    const rendered: string[] = await renderQuery(" 小号  也有啊 ", "inline-source-1");
    expect(rendered).toHaveLength(2);
    // 登记的是归一后的源文本，与 renderGagSpeech 内部变形前用的是同一段文本。
    for (const messageText of rendered) {
      expect(inlineResultSourceOf(messageText)).toBe("小号 也有啊");
    }

    // 每敲一个键就来一次应答并整体覆盖：上一次按键那些结果再也取不回源文本，
    // 只会被当成拿不到，而不会拿这次的源文本去判上一次那条正文。
    const latest: string[] = await renderQuery("小号也有啊喵", "inline-source-2");
    expect(inlineResultSourceOf(latest[0]!)).toBe("小号也有啊喵");
    expect(inlineResultSourceOf(rendered[0]!)).toBeUndefined();

    // 源文本为空的应答不登记：那种结果只有前缀和填充点，没有一个字是用户写的。
    const emptyRendered: string[] = await renderQuery("", "inline-source-empty");
    expect(inlineResultSourceOf(emptyRendered[0]!)).toBeUndefined();
    expect(inlineResultSourceOf(latest[0]!)).toBe("小号也有啊喵");
  });

  test("频道查询只携带目标 ID，结果用主页和超级群 ID 双重绑定落点", async () => {
    const channelSession: GagSession = createSession({
      targetId: -1002233445566,
    });
    addSession(channelSession);

    const handled: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-channel",
        from: { id: 4_242, is_bot: false, first_name: "Admin" },
        query: `gag:${channelSession.targetId} 功能没了喵`,
        offset: "",
      },
      answerInlineQuery,
    } as never);

    expect(handled).toBeTrue();
    const results: readonly InlineResult[] = answerInlineQuery.mock.calls[0]?.[0] ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("gag--1001--1002233445566");
    expect(results[0]?.title).toBe("以频道身份发言");
    const content: { message_text: string; entities?: MessageEntity[] } =
      results[0]?.input_message_content as {
        message_text: string;
        entities?: MessageEntity[];
      };
    const messageText: string = content.message_text;
    expect(messageText).toStartWith("（透过口塞）");
    expect(messageText.length).toBeGreaterThan(
      rendering.gagSpeechPrefix("口塞").length
    );
    expect(messageText).not.toContain("-1002233445566");
    expect(content.entities?.[0]).toEqual({
      type: "text_link",
      offset: 0,
      length: rendering.gagSpeechPrefix("口塞").length,
      url: "https://t.me/c/2233445566/1#-1001",
    });
  });

  test("非法或过期 gag 前缀静默返回空结果，不生成可发送拒绝文本", async () => {
    const userSession: GagSession = createSession();
    addSession(userSession);
    const handled: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-stolen-user",
        from: { id: 8, is_bot: false, first_name: "Bob" },
        query: `gag:${userSession.targetId} `,
        offset: "",
      },
      answerInlineQuery,
    } as never);

    expect(handled).toBeTrue();
    let results: readonly InlineResult[] = answerInlineQuery.mock.calls[0]?.[0] ?? [];
    expect(results).toHaveLength(0);

    gag.resetGagSessions();
    answerInlineQuery.mockClear();
    await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-stale",
        from: { id: 100, is_bot: false, first_name: "Admin" },
        query: "gag:-1002233445566",
        offset: "",
      },
      answerInlineQuery,
    } as never);
    results = answerInlineQuery.mock.calls[0]?.[0] ?? [];
    expect(results).toHaveLength(0);
  });

  test("同一用户在多群的选项最多 5 条，一次回完不带分页", async () => {
    for (let index: number = 0; index < GAG_SESSION_MAX; index++) {
      const chatId: number = -10_000 - index;
      addSession(createSession({ chatId }));
    }
    const context: Record<string, unknown> = {
      inlineQuery: {
        id: "inline-page",
        from: { id: 7, is_bot: false, first_name: "Alice" },
        query: "gag:7 测试",
        offset: "",
      },
      answerInlineQuery,
    };
    expect(await gag.handleGagInlineQuery(context as never)).toBeTrue();
    expect(answerInlineQuery.mock.calls[0]?.[0]).toHaveLength(GAG_SESSION_MAX);
    // GAG_SESSION_MAX 是跨全部群的全局上限，远小于 answerInlineQuery 的 50 条
    // 上限，因此不存在第二页，也就不再回 next_offset。
    expect(answerInlineQuery.mock.calls[0]?.[1]).toEqual({
      cache_time: 0,
      is_personal: true,
    });
  });
});
