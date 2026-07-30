import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdDetectedEvent } from "../../../packages/types/antiRaid";
import type { AdMessageBundle } from "../../../packages/types/antiRaid/adDetect";

const deleteMessage = mock(async (..._args: unknown[]): Promise<boolean> => true);
const deleteMessages = mock(async (..._args: unknown[]): Promise<boolean> => true);
const deleteMessageAfter = mock((..._args: unknown[]): void => {});
const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 555);
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
  deleteMessageAfter,
  sendMessage,
  joinVerificationApi: { kind: "guard-api" },
}));

const { disposeAdSender } = await import("../../../packages/workers/antiRaid/adDetect/disposal");
const { adDetectPublishHolder } = await import("../../../packages/cache/workers/antiRaid/adDetect");

function bundle(): AdMessageBundle {
  return {
    chatId: -1001,
    senderId: 7,
    label: "@spammer",
    isChannel: false,
    justJoined: false,
    entries: [
      { messageId: 11, seq: 1, text: "加我", receivedAt: 1_000, replyTo: "在吗" },
      { messageId: 12, seq: 2, text: "微信 xxx", receivedAt: 1_100 },
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
  deleteMessageAfter.mockClear();
  sendMessage.mockClear();
  adDetectPublishHolder.current = null;
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
      reason: "引流加微信",
      // 判定依据的整串原样回投，供主线程写进命中样本；只给人看的引用/回复
      // 上下文跟着各自那条消息走，判定文本里从来没有它们。
      messages: [
        { messageId: 11, text: "加我", replyTo: "在吗" },
        { messageId: 12, text: "微信 xxx" },
      ],
    }]);
    // 整串走一次批量删除：逐条删会把一次处置放大成几十个往返，顶在共用
    // joinVerificationApi 队列上的验证超时踢人前面。
    expect(deleteMessages).toHaveBeenCalledTimes(1);
    expect(deleteMessages.mock.calls[0]?.[1]).toEqual([11, 12]);
    // 播报的文案要断言「在所有盯着的群里一起封掉了」，而此刻一个群都还没登记：
    // 谁知道结果谁播报，因此这一步不在本线程做（见 antiRaid/adDetect.ts）。
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessageAfter).not.toHaveBeenCalled();
  });

  test("样本只记模型真正读过的那一份，删除取判定依据与现场的并集", async () => {
    const live: AdMessageBundle = bundle();
    // 送检那一刻定格的两条。
    const judged = [...live.entries];
    // 判定往返期间发生的两件事：同一个人又发了一条（并进活对象），而最早那条
    // 被单 key 条数/字符预算挤出了当前上下文。
    live.entries = [
      { messageId: 12, seq: 2, text: "微信 xxx", receivedAt: 1_100 },
      { messageId: 13, seq: 3, text: "带你上岸", receivedAt: 1_200 },
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
    live.pendingDeleteIds = Array.from({ length: 150 }, (_value, index) => 1_000 + index);

    adDetectPublishHolder.current = (): void => {};
    await disposeAdSender({ bundle: live, judged: live.entries, verdict: { isAd: true, reason: "引流" } });

    // deleteMessages 只有整体成败：一次带满 152 条会让整批被拒、一条都删不掉，
    // 比不转存那些 id 还糟。
    expect(deleteMessages).toHaveBeenCalledTimes(2);
    expect((deleteMessages.mock.calls[0]?.[1] as number[]).length).toBe(100);
    expect((deleteMessages.mock.calls[1]?.[1] as number[]).length).toBe(52);
  });

  test("回投通道已关闭时删消息照做，只记一行错误日志", async () => {
    await disposeAdSender({ bundle: bundle(), judged: bundle().entries, verdict: { isAd: true, reason: "卖号" } });
    expect(errorLogs[0]).toContain("main-thread channel is closed");
    // 那一串确实是广告，删掉没问题。
    expect(deleteMessages).toHaveBeenCalledTimes(1);
    // 拉黑与各群封禁永远不会发生，跟着结果走的播报自然也不会有。
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
