import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdDetectedEvent } from "../../../packages/types/antiRaid";
import type { AdMessageBundle } from "../../../packages/types/antiRaid/adDetect";
import type { TelegramWorkerTemporaryMessageResult } from "../../../packages/types/telegramWorker";

const deleteMessage = mock(async (..._args: unknown[]): Promise<boolean> => true);
const deleteMessages = mock(async (..._args: unknown[]): Promise<boolean> => true);
const sendTemporaryMessageFromMain = mock(async (
  ..._args: unknown[]
): Promise<TelegramWorkerTemporaryMessageResult | undefined> => ({
  messageId: 555,
  sentAt: 1_500,
}));
const errorLogs: string[] = [];

mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../../packages/infra/telegram", () => ({
  deleteMessage,
  deleteMessages,
  telegramApi: { kind: "guard-api" },
}));
mock.module("../../../packages/infra/telegram/workerClient", () => ({
  sendTemporaryMessageFromMain,
}));

const {
  deleteReferencedAdMessages,
  deleteStragglerAdMessage,
  disposeAdSender,
  formatReferencedAdWarning,
  deleteStaleReferencedAdWarning,
  warnReferencedAdSender,
} = await import("../../../packages/workers/antiRaid/adDetect/disposal");
const { adDetectPublishHolder, inFlightReferencedAdCleanupTasks } =
  await import("../../../packages/cache/workers/antiRaid/adDetect");
const { KICK_NOTICE_AUTO_DELETE_MS } = await import("../../../packages/consts/telegram");
const { AD_DETECT_MAX_IN_FLIGHT } = await import(
  "../../../packages/consts/antiRaid/adDetect"
);
const {
  applyBotPermissionsChange,
  resetWorkerBotPermissions,
} = await import("../../../packages/workers/antiRaid/botPermissions");

function bundle(): AdMessageBundle {
  return {
    chatId: -1001,
    senderId: 7,
    label: "@spammer",
    meta: { firstName: "Spammer", lastName: "", username: "spammer" },
    isChannel: false,
    justJoined: false,
    entries: [
      {
        messageId: 11,
        seq: 1,
        text: "加我",
        directText: "加我",
        receivedAt: 1_000,
        withinReferencedWarning: false,
        replyTo: "在吗",
      },
      {
        messageId: 12,
        seq: 2,
        text: "微信 xxx",
        directText: "微信 xxx",
        receivedAt: 1_100,
        withinReferencedWarning: false,
      },
    ],
    pendingDeleteIds: [],
    nextSeq: 3,
    checkedSeq: 0,
  };
}

beforeEach(() => {
  errorLogs.length = 0;
  deleteMessage.mockClear();
  deleteMessages.mockClear();
  deleteMessages.mockImplementation(async (): Promise<boolean> => true);
  sendTemporaryMessageFromMain.mockClear();
  sendTemporaryMessageFromMain.mockImplementation(async (): Promise<TelegramWorkerTemporaryMessageResult> => ({
    messageId: 555,
    sentAt: 1_500,
  }));
  adDetectPublishHolder.current = null;
  inFlightReferencedAdCleanupTasks.clear();
  resetWorkerBotPermissions();
});

describe("广告处置副作用", () => {
  test("回投主线程并删掉整串消息，但播报留给主线程发", async () => {
    const events: AdDetectedEvent[] = [];
    adDetectPublishHolder.current = (event: AdDetectedEvent): void => { events.push(event); };

    await disposeAdSender({ bundle: bundle(), judged: bundle().entries, verdict: { isAd: true, reason: "引流加微信" } });

    expect(events).toEqual([{
      type: "adDetected",
      chatId: -1001,
      senderId: 7,
      isChannel: false,
      label: "@spammer",
      meta: { firstName: "Spammer", lastName: "", username: "spammer" },
      reason: "引流加微信",
      // 判定依据的整串原样回投，供主线程写进命中样本；只给人看的引用/回复
      // 上下文跟着各自那条消息走，判定文本里从来没有它们。
      messages: [
        { messageId: 11, text: "加我", replyTo: "在吗" },
        { messageId: 12, text: "微信 xxx" },
      ],
    }]);
    // 整串走一次批量删除：逐条删会把一次处置放大成几十个往返，在 delete
    // 类别发生 429 时也会无谓扩大这条独立 FIFO 的积压。
    expect(deleteMessages).toHaveBeenCalledTimes(1);
    expect(deleteMessages.mock.calls[0]?.[1]).toEqual([11, 12]);
    // 播报的文案要断言「在所有盯着的群里一起封掉了」，而此刻一个群都还没登记：
    // 谁知道结果谁播报，因此这一步不在本线程做（见 antiRaid/adDetect.ts）。
    expect(sendTemporaryMessageFromMain).not.toHaveBeenCalled();
  });

  test("样本只记模型真正读过的那一份，删除取判定依据与现场的并集", async () => {
    const live: AdMessageBundle = bundle();
    // 送检那一刻定格的两条。
    const judged = [...live.entries];
    // 判定往返期间发生的两件事：同一个人又发了一条（并进活对象），而最早那条
    // 被单 key 条数/字符预算挤出了当前上下文。
    live.entries = [
      {
        messageId: 12,
        seq: 2,
        text: "微信 xxx",
        directText: "微信 xxx",
        receivedAt: 1_100,
        withinReferencedWarning: false,
      },
      {
        messageId: 13,
        seq: 3,
        text: "带你上岸",
        directText: "带你上岸",
        receivedAt: 1_200,
        withinReferencedWarning: false,
      },
    ];

    const events: AdDetectedEvent[] = [];
    adDetectPublishHolder.current = (event: AdDetectedEvent): void => { events.push(event); };
    await disposeAdSender({ bundle: live, judged, verdict: { isAd: true, reason: "引流" } });

    // 样本必须是模型读过的那两条：把它没读过的 13 写进「判定依据」，人回头
    // 复现的就是另一串内容，而样本文件存在的唯一理由就是复现它读过的东西。
    expect(events[0]?.messages.map((message) => message.messageId)).toEqual([11, 12]);
    // 删除则要覆盖两边：只删 judged 会放过抢跑发出来的 13，只删现场会漏掉
    // 已被裁掉、但模型确实据以判定的 11。
    expect(deleteMessages.mock.calls[0]?.[1]).toEqual([11, 12, 13]);
  });

  test("被挤出上下文、从没判过的消息也进删除集合", async () => {
    const live: AdMessageBundle = bundle();
    // 爆发式刷屏：上限撑满时只剩没判过的可丢，正文不留但 id 转存下来。
    live.pendingDeleteIds = [9, 10];

    adDetectPublishHolder.current = (): void => {};
    await disposeAdSender({ bundle: live, judged: live.entries, verdict: { isAd: true, reason: "引流" } });

    // 不带上它们的话，这些广告既没进过判定也没人删，会永久留在群里——频道马甲
    // 尤其如此，banChatSenderChat 没有 revoke_messages。
    expect(deleteMessages.mock.calls[0]?.[1]).toEqual([11, 12, 9, 10]);
  });

  test("并集超过接口单次上限时分片删除，不让整批被拒", async () => {
    const live: AdMessageBundle = bundle();
    // 爆发式刷屏攒出的待删 id 可以远超 100（见 AD_DETECT_MAX_PENDING_DELETE_IDS）。
    live.pendingDeleteIds = Array.from(
      { length: 150 },
      (_value, index): number => 1_000 + index
    );

    adDetectPublishHolder.current = (): void => {};
    await disposeAdSender({ bundle: live, judged: live.entries, verdict: { isAd: true, reason: "引流" } });

    // deleteMessages 只有整体成败：一次带满 152 条会让整批被拒、一条都删不掉，
    // 比不转存那些 id 还糟。
    expect(deleteMessages).toHaveBeenCalledTimes(2);
    expect((deleteMessages.mock.calls[0]?.[1] as number[]).length).toBe(100);
    expect((deleteMessages.mock.calls[1]?.[1] as number[]).length).toBe(52);
  });

  test("已确证没有删消息权限时仍回投拉黑，但不发送注定失败的删除请求", async (): Promise<void> => {
    const events: AdDetectedEvent[] = [];
    adDetectPublishHolder.current = (event: AdDetectedEvent): void => {
      events.push(event);
    };
    applyBotPermissionsChange(-1001, {
      canRestrictMembers: true,
      canDeleteMessages: false,
    });

    await disposeAdSender({
      bundle: bundle(),
      judged: bundle().entries,
      verdict: { isAd: true, reason: "引流" },
    });
    deleteStragglerAdMessage(-1001, 99);

    expect(events).toHaveLength(1);
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(errorLogs.some((message: string): boolean =>
      message.includes("known to lack can_delete_messages")
    )).toBeTrue();
  });

  test("Telegram 批量删除明确失败时只汇总一条权限诊断", async (): Promise<void> => {
    deleteMessages.mockImplementation(async (): Promise<boolean> => false);
    adDetectPublishHolder.current = (): void => {};

    await disposeAdSender({
      bundle: bundle(),
      judged: bundle().entries,
      verdict: { isAd: true, reason: "引流" },
    });

    expect(deleteMessages).toHaveBeenCalledTimes(1);
    expect(errorLogs.some((message: string): boolean =>
      message.includes("could not delete 1 batch(es)")
    )).toBeTrue();
  });

  test("回投通道已关闭时删消息照做，只记一行错误日志", async () => {
    await disposeAdSender({ bundle: bundle(), judged: bundle().entries, verdict: { isAd: true, reason: "卖号" } });
    expect(errorLogs[0]).toContain("main-thread channel is closed");
    // 那一串确实是广告，删掉没问题。
    expect(deleteMessages).toHaveBeenCalledTimes(1);
    // 拉黑与各群封禁永远不会发生，跟着结果走的播报自然也不会有。
    expect(sendTemporaryMessageFromMain).not.toHaveBeenCalled();
  });

  test("引用类广告第一次只公开警告并清消息，文案不泄露五分钟升级窗口", async () => {
    const live: AdMessageBundle = bundle();
    const result: TelegramWorkerTemporaryMessageResult | undefined =
      await warnReferencedAdSender(live);
    deleteReferencedAdMessages({
      bundle: live,
      judged: live.entries,
      messageIdThrough:
        result !== undefined && "messageId" in result
          ? result.messageId
          : Number.NEGATIVE_INFINITY,
    });

    const warning: string = formatReferencedAdWarning("@spammer");
    expect(warning).toContain("不要回复、引用或转发广告相关内容");
    expect(warning).toContain("连这点都记不住吗，杂鱼♡");
    expect(warning).not.toContain("五分钟");
    expect(warning).not.toContain("5 分钟");
    expect(sendTemporaryMessageFromMain).toHaveBeenCalledWith({
      chatId: -1001,
      identityId: 7,
      text: warning,
      deleteAfterMs: KICK_NOTICE_AUTO_DELETE_MS,
    });
    expect(result).toEqual({ messageId: 555, sentAt: 1_500 });
    expect(deleteMessages.mock.calls[0]?.[1]).toEqual([11, 12]);
    expect(adDetectPublishHolder.current).toBeNull();
  });

  test("公开警告发送失败时不上报成功，消息清理由队列按当前状态决定", async () => {
    sendTemporaryMessageFromMain.mockImplementationOnce(
      async (): Promise<undefined> => undefined
    );

    expect(await warnReferencedAdSender(bundle())).toBeUndefined();
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  test("第一次清理按群内消息顺序截断，不误删发送回执落定前的警告后回复", () => {
    const live: AdMessageBundle = bundle();
    live.entries.push({
      messageId: 556,
      seq: 3,
      text: "警告后回复",
      directText: "警告后回复",
      // 本机时间早于发送回执也不影响 Telegram 群内的权威消息顺序。
      receivedAt: 1_400,
      withinReferencedWarning: true,
    });
    live.pendingDeleteIds = [10, 557];

    deleteReferencedAdMessages({
      bundle: live,
      judged: live.entries.slice(0, 2),
      messageIdThrough: 555,
    });

    expect(deleteMessages.mock.calls[0]?.[1]).toEqual([11, 12, 10]);
  });

  test("慢删除在独立有界集合结算，不扣住警告发送或分类 key", async () => {
    let resolveDelete!: (deleted: boolean) => void;
    deleteMessages.mockImplementationOnce((): Promise<boolean> =>
      new Promise<boolean>((resolve: (deleted: boolean) => void): void => {
        resolveDelete = resolve;
      }));
    const live: AdMessageBundle = bundle();

    deleteReferencedAdMessages({
      bundle: live,
      judged: live.entries,
      messageIdThrough: 555,
    });

    expect(inFlightReferencedAdCleanupTasks.size).toBe(1);
    expect(await warnReferencedAdSender(live)).toEqual({
      messageId: 555,
      sentAt: 1_500,
    });
    resolveDelete(true);
    await Bun.sleep(0);
    expect(inFlightReferencedAdCleanupTasks.size).toBe(0);
  });

  test("引用广告清理任务达到硬顶后拒绝新增，不让 Promise 集合无限增长", (): void => {
    for (
      let index: number = 0;
      index < AD_DETECT_MAX_IN_FLIGHT;
      index++
    ) {
      inFlightReferencedAdCleanupTasks.add(Promise.resolve());
    }

    const live: AdMessageBundle = bundle();
    deleteReferencedAdMessages({
      bundle: live,
      judged: live.entries,
      messageIdThrough: 555,
    });

    expect(inFlightReferencedAdCleanupTasks.size).toBe(
      AD_DETECT_MAX_IN_FLIGHT
    );
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(errorLogs.some((message: string): boolean =>
      message.includes("cleanup task ceiling is full")
    )).toBeTrue();
  });

  test("引用广告清理异常被统一记录，并在结算后释放任务槽位", async (): Promise<void> => {
    const failure: Error = new Error("delete unavailable");
    deleteMessages.mockRejectedValueOnce(failure);
    const live: AdMessageBundle = bundle();

    deleteReferencedAdMessages({
      bundle: live,
      judged: live.entries,
      messageIdThrough: 555,
    });
    const tasks: Promise<void>[] = [...inFlightReferencedAdCleanupTasks];
    await Promise.allSettled(tasks);
    await Bun.sleep(0);

    expect(errorLogs.some((message: string): boolean =>
      message.includes("Unexpected error while deleting referenced ad messages")
    )).toBeTrue();
    expect(inFlightReferencedAdCleanupTasks.size).toBe(0);
  });

  test("迟到警告可立即撤回，不改动广告消息", () => {
    deleteStaleReferencedAdWarning(-1001, 555);
    expect(deleteMessage).toHaveBeenCalledWith(
      -1001,
      555,
      { kind: "guard-api" }
    );
    expect(deleteMessages).not.toHaveBeenCalled();
  });
});
