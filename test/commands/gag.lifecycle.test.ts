/** `/gag` 与 `/ungag` 的容量预约、提示收尾与停机排空状态机。 */

import { describe, expect, test } from "bun:test";
import {
  GAG_SESSION_MAX,
} from "../../packages/consts/gag";
import type { CachedUser } from "../../packages/types/chatState";
import type { GagSession } from "../../packages/types/gag";
import { settleTestBatch } from "../libs/helpers";
import {
  activeGagSessionCount,
  addSession,
  commandContext,
  createSession,
  deleteEphemeralMessageWithOutcome,
  deleteMessageWithOutcome,
  gagSessionCount,
  gagSessionsByChat,
  lastCommandText,
  lastEphemeralText,
  lastStateText,
  normalMessage,
  probeChatMembership,
  resolveCommandTarget,
  sendCommandMessage,
  sendEphemeralMessage,
  sendMessage,
  sessionFor,
  installGagTestHooks,
  gagTestSwitches,
} from "../helpers/gagHarness";
import type {
  EphemeralDeletionParams,
  EphemeralMessageParams,
  TextMessageParams,
} from "../helpers/gagHarness";

const gag = await import("../../packages/commands/gag");

installGagTestHooks();

describe("/gag 与 /ungag 状态机", () => {
  test("权限、初始化和删除权限逐层 fail closed", async () => {
    gagTestSwitches.permissionAllowed = false;
    await gag.handleGagCommand(commandContext());
    expect(resolveCommandTarget).not.toHaveBeenCalled();

    gagTestSwitches.permissionAllowed = true;
    gagTestSwitches.initEnabled = false;
    await gag.handleGagCommand(commandContext());
    expect(resolveCommandTarget).not.toHaveBeenCalled();

    gagTestSwitches.initEnabled = true;
    gagTestSwitches.canDeleteMessages = false;
    await gag.handleGagCommand(commandContext());
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(sendCommandMessage).toHaveBeenCalledTimes(3);
  });

  test("普通用户先收到群内无按钮状态，再收到目标专属入口，全部成功后才激活", async () => {
    await gag.handleGagCommand(commandContext({ match: "@alice 5" }));

    const session: GagSession | undefined = sessionFor(-1001);
    expect(session?.phase).toBe("active");
    expect(session?.expiresAt).toBe(1_300_000);
    expect(session?.publicNoticeMessageId).toBe(56);
    expect(session?.speakNoticeMessageId).toBe(57);
    expect(session?.timer).not.toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: -1001,
      replyToMessageId: 10,
    });
    expect(sendMessage.mock.calls[0]?.[0]).not.toHaveProperty("keyboard");
    expect(lastStateText()).toContain("已经戴上");
    expect(lastStateText()).not.toContain("发言入口");
    expect(sendEphemeralMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: -1001,
      receiverUserId: 7,
    });
    expect(sendEphemeralMessage.mock.calls[0]?.[0]).not
      .toHaveProperty("callbackQueryId");
    const sessionButton = sendEphemeralMessage.mock.calls[0]?.[0]?.keyboard
      ?.inline_keyboard[0]?.[0];
    expect(sessionButton).toMatchObject({
      text: "发言",
      switch_inline_query_current_chat: "gag: ",
    });
    expect(sessionButton).not.toHaveProperty("callback_data");
    expect(resolveCommandTarget.mock.calls[0]?.[0]).toMatchObject({
      botUserId: 999,
      messages: { selfTarget: "哈？还想 gag 本天才？杂鱼再做一百年梦也不可能啦♡" },
    });
    expect(lastEphemeralText()).toContain("只有你看得到这个发言入口");
  });

  test("回复目标只写用具时使用默认 5 分钟，并把空目标交给回复解析", async () => {
    await gag.handleGagCommand(commandContext({
      match: "丝带",
      replyToMessage: normalMessage(),
    }));

    const session: GagSession | undefined = sessionFor(-1001);
    expect(session?.durationMinutes).toBe(5);
    expect(session?.tool).toBe("丝带");
    expect(resolveCommandTarget.mock.calls[0]?.[0]).toMatchObject({ rawArgument: "" });
  });

  test("群内状态发送失败释放预约，且不再发送目标入口", async () => {
    sendMessage.mockImplementationOnce(async (_params: TextMessageParams): Promise<undefined> => undefined);
    await gag.handleGagCommand(commandContext());
    expect(gagSessionsByChat.has(-1001)).toBeFalse();
    expect(sendEphemeralMessage).not.toHaveBeenCalled();
  });

  test("目标入口发送失败时删除已发出的群内状态并释放预约", async () => {
    sendEphemeralMessage.mockImplementationOnce(async (_params: EphemeralMessageParams): Promise<undefined> => undefined);
    await gag.handleGagCommand(commandContext());
    expect(gagSessionsByChat.has(-1001)).toBeFalse();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 56);
  });

  test("同群可管教多个目标，但同目标不重复，全局最多 5 个", async () => {
    addSession(createSession());
    resolveCommandTarget.mockImplementationOnce(async (_params: unknown): Promise<CachedUser> => ({
      id: 8,
      first_name: "Bob",
    }));
    await gag.handleGagCommand(commandContext({ match: "8" }));
    expect(gagSessionsByChat.get(-1001)).toHaveLength(2);

    sendCommandMessage.mockClear();
    probeChatMembership.mockClear();
    await gag.handleGagCommand(commandContext());
    expect(gagSessionsByChat.get(-1001)).toHaveLength(2);
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    expect(lastCommandText()).toContain("已经被管教");

    gag.resetGagSessions();
    sendCommandMessage.mockClear();
    for (let index: number = 0; index < GAG_SESSION_MAX; index++) {
      const chatId: number = -10_000 - index;
      addSession(createSession({ chatId }));
    }
    await gag.handleGagCommand(commandContext({ chatId: -999 }));
    expect(gagSessionCount()).toBe(GAG_SESSION_MAX);
    expect(activeGagSessionCount()).toBe(GAG_SESSION_MAX);
    expect(lastCommandText()).toContain(String(GAG_SESSION_MAX));
  });

  test("目标不豁免白名单身份，但必须是当前群成员", async () => {
    resolveCommandTarget.mockImplementationOnce(async (_params: unknown): Promise<CachedUser> => ({
      id: 100,
      first_name: "Admin",
    }));
    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);

    gag.resetGagSessions();
    probeChatMembership.mockImplementationOnce(async (_chatId: number, _userId: number): Promise<boolean> => false);
    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    expect(lastCommandText()).toContain("不在这个群");
  });

  test("频道身份可通过回复、@username 或负数 id 被 gag，且不误用用户成员查询", async () => {
    resolveCommandTarget.mockImplementationOnce(async (
      params: unknown
    ): Promise<CachedUser> => {
      expect(params).toMatchObject({ acceptChatId: true });
      return { id: -1002233445566, isChannel: true, title: "测试频道" };
    });
    await gag.handleGagCommand(commandContext({ match: "-1002233445566" }));

    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(sessionFor(-1001, -1002233445566)?.targetId).toBe(-1002233445566);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]?.keyboard?.inline_keyboard[0]?.[0])
      .toMatchObject({
        text: "发言",
        switch_inline_query_current_chat:
          expect.stringMatching(/^gag:-1002233445566:[0-9a-f]{16} $/) as unknown as string,
      });
    expect(lastStateText()).toContain("频道马甲想说话就必须先乖乖点");
    expect(lastStateText()).toContain("直接 @ 本天才可不会给你选项");
  });

  test("/ungag 按 @ 目标删除开始提示、释放状态并发送统一 30 秒回执", async () => {
    const session: GagSession = createSession();
    addSession(session);
    resolveCommandTarget.mockClear();
    await gag.handleUngagCommand(commandContext({ match: "@alice" }));

    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
    expect(resolveCommandTarget).toHaveBeenCalledWith(expect.objectContaining({
      acceptChatId: true,
      acceptUserId: true,
      rawArgument: "@alice",
    }));
    expect(sendCommandMessage).toHaveBeenCalledTimes(1);
    expect(lastCommandText()).toContain("提前解除");
  });

  test("/ungag 必须定向目标，并支持回复、@ 和正负 id", async () => {
    resolveCommandTarget.mockImplementationOnce(async (_params: unknown): Promise<undefined> => undefined);
    await gag.handleUngagCommand(commandContext({ match: "" }));
    expect(sendCommandMessage).not.toHaveBeenCalled();

    for (const rawArgument of ["@alice", "7", "-1002233445566"]) {
      sendCommandMessage.mockClear();
      await gag.handleUngagCommand(commandContext({ match: rawArgument }));
      expect(lastCommandText()).toContain("根本没被");
    }
    sendCommandMessage.mockClear();
    await gag.handleUngagCommand(commandContext({
      match: "",
      replyToMessage: normalMessage(),
    }));
    expect(resolveCommandTarget.mock.calls.at(-1)?.[0]).toMatchObject({
      rawArgument: "",
      message: expect.objectContaining({ reply_to_message: expect.anything() }),
    });
    expect(lastCommandText()).toContain("根本没被");
  });

  test("teardown 静默删除提示，不发送解除回执", async () => {
    const session: GagSession = createSession();
    const second: GagSession = createSession({
      targetId: -1002233445566,
      speakNoticeMessageId: 66,
    });
    addSession(session);
    addSession(second);
    await gag.teardownGagInChat(session.chatId);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 66);
    expect(sendCommandMessage).not.toHaveBeenCalled();
    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
  });

  test("提示删除失败时保留 ending owner，后续 teardown 成功才释放", async () => {
    deleteEphemeralMessageWithOutcome.mockImplementationOnce(
      async (): Promise<string> => "failed"
    );
    const session: GagSession = createSession();
    addSession(session);

    await gag.teardownGagInChat(session.chatId);
    expect(sessionFor(session.chatId)).toBe(session);
    expect(session.phase).toBe("ending");
    expect(session.cleanupTimer).not.toBeNull();
    expect(sendCommandMessage).not.toHaveBeenCalled();

    await gag.teardownGagInChat(session.chatId);
    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(2);
  });

  test("进程 drain 在 Telegram 总闸关闭前删除提示，并停止接纳新会话", async () => {
    const session: GagSession = createSession();
    addSession(session);

    await expect(gag.drainGagRuntime(1_000)).resolves.toBe("flushed");
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
    expect(gagSessionsByChat.size).toBe(0);

    sendEphemeralMessage.mockClear();
    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).not.toHaveBeenCalled();

    gag.initGagRuntime();
    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
  });

  test("旧会话 Telegram 收尾未完成时保持 ending 占位，不让新 gag 穿插", async () => {
    let finishDelete: (() => void) | undefined;
    deleteEphemeralMessageWithOutcome.mockImplementationOnce((_params: EphemeralDeletionParams): Promise<string> =>
      new Promise<string>((resolve: (value: string) => void): void => {
        finishDelete = (): void => resolve("deleted");
      })
    );
    const session: GagSession = createSession();
    addSession(session);
    const teardown: Promise<void> = gag.teardownGagInChat(session.chatId);
    await Promise.resolve();
    expect(sessionFor(session.chatId)?.phase).toBe("ending");

    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).not.toHaveBeenCalled();
    expect(lastCommandText()).toContain("收尾");

    finishDelete!();
    await teardown;
    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
  });

  test("开始提示已删但解除回执仍在途时，ending 独占任务继续占住槽位", async () => {
    let finishReceipt: ((messageId: number) => void) | undefined;
    sendCommandMessage.mockImplementationOnce((_params: TextMessageParams): Promise<number> =>
      new Promise<number>((resolve: (messageId: number) => void): void => {
        finishReceipt = resolve;
      })
    );
    const session: GagSession = createSession();
    addSession(session);

    const ungag: Promise<void> = gag.handleUngagCommand(commandContext());
    for (let step: number = 0; step < 6 && finishReceipt === undefined; step++) {
      await Promise.resolve();
    }
    expect(finishReceipt).toBeDefined();
    expect(session.phase).toBe("ending");
    expect(session.endingTask).not.toBeNull();
    expect(sessionFor(session.chatId)).toBe(session);

    const teardown: Promise<void> = gag.teardownGagInChat(session.chatId);
    await Promise.resolve();
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(sessionFor(session.chatId)).toBe(session);

    finishReceipt!(56);
    await settleTestBatch([ungag, teardown]);
    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
  });

  test("teardown 在开始提示发送期间到达时不会复活会话，并撤掉迟到提示", async () => {
    let finishSend: ((messageId: number) => void) | undefined;
    sendEphemeralMessage.mockImplementationOnce((_params: EphemeralMessageParams): Promise<number> =>
      new Promise<number>((resolve: (messageId: number) => void): void => {
        finishSend = resolve;
      })
    );
    const starting: Promise<void> = gag.handleGagCommand(commandContext());
    for (let step: number = 0; step < 6 && finishSend === undefined; step++) {
      await Promise.resolve();
    }
    expect(finishSend).toBeDefined();
    expect(sessionFor(-1001)?.phase).toBe("starting");

    await gag.teardownGagInChat(-1001);
    finishSend!(77);
    await starting;
    expect(gagSessionsByChat.has(-1001)).toBeFalse();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 56);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 77,
    });
  });

  test("回归：提示已发出后遭遇停机 abort，message id 不丢，排空仍能删掉它", async () => {
    // 远端已经收下提示、handler 还没走到提交那一行时 runner.abortActive() 落下：
    // await 以 AbortError 解开并带走返回值。没有同步登记的话这条提示从此没人
    // 知道它的 id，drainGagRuntime 每次都判 failed，进程带非零码退出并扣住实例锁。
    sendEphemeralMessage.mockImplementationOnce(
      async (params: EphemeralMessageParams & { readonly onSent?: (messageId: number) => void }): Promise<number> => {
        params.onSent?.(91);
        throw new DOMException("Telegram update aborted during shutdown.", "AbortError");
      }
    );

    await expect(gag.handleGagCommand(commandContext())).rejects.toThrow();
    expect(gagSessionsByChat.size).toBe(0);
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 56);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 91,
    });

    await expect(gag.drainGagRuntime(1_000)).resolves.toBe("flushed");
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 91,
    });
    expect(gagSessionsByChat.size).toBe(0);
    gag.initGagRuntime();
  });

  test("回归：目标入口没发出去就 abort 时删除公开状态并撤销预约", async () => {
    sendEphemeralMessage.mockImplementationOnce(async (): Promise<number> => {
      throw new DOMException("Telegram update aborted during shutdown.", "AbortError");
    });

    await expect(gag.handleGagCommand(commandContext())).rejects.toThrow();
    expect(gagSessionsByChat.size).toBe(0);
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 56);

    await expect(gag.drainGagRuntime(1_000)).resolves.toBe("flushed");
    expect(deleteEphemeralMessageWithOutcome).not.toHaveBeenCalled();
    gag.initGagRuntime();
  });
});
