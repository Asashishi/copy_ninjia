import { beforeEach, describe, expect, test } from "bun:test";
import type { AdVerdict } from "../../../packages/types/antiRaid/adDetect";
import type { TelegramWorkerTemporaryMessageResult } from "../../../packages/types/telegramWorker";
import {
  cachedAdmins,
  candidate,
  classifiedTexts,
  classifyAdText,
  deleteReferencedAdMessages,
  deleteStaleReferencedAdWarning,
  deleteStragglerAdMessage,
  disposeAdSender,
  fetchedAdmins,
  resetAdDetectQueueHarness,
  setAdDetectWarningNow,
  warnReferencedAdSender,
} from "../../helpers/adDetectQueueHarness";

const {
  clearChatAdDetect,
  enqueueAdCandidate,
  expireAdDetectDisposalMarkers,
  releaseAdDetectDedupKey,
  runAdDetectBatch,
  stopAdDetectQueue,
} = await import("../../../packages/workers/antiRaid/adDetect/queue");
const {
  adDetectQueue,
  inFlightAdDetectKeys,
  pendingAdMessages,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
  referencedAdWarningStates,
} = await import("../../../packages/cache/workers/antiRaid/adDetect");
const {
  AD_REFERENCE_WARNING_WINDOW_MS,
} = await import("../../../packages/consts/antiRaid/adDetect");

beforeEach((): void => resetAdDetectQueueHarness(stopAdDetectQueue));

describe("引用类广告的警告升级与处置抑制", () => {
  test("引用类广告第一次只公开警告并清串，警告后下一条可立即重新判定", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    enqueueAdCandidate(candidate({
      text: "这种广告真烦",
      sampleContext: { quote: "日入过千 加V xxx996" },
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(classifiedTexts).toEqual([
      "1. 这种广告真烦 日入过千 加V xxx996",
      "1. 这种广告真烦",
    ]);
    expect(warnReferencedAdSender).toHaveBeenCalledTimes(1);
    expect(disposeAdSender).not.toHaveBeenCalled();
    expect(referencedAdWarningStates.get("-1001:7")).toMatchObject({
      phase: "warned",
      warnedAt: 1_000,
      expiresAt: 1_000 + AD_REFERENCE_WARNING_WINDOW_MS,
    });
    expect(pendingAdMessages.has("-1001:7")).toBe(false);
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(false);

    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "又来一条",
      sampleContext: { replyTo: "日入过千 加V second" },
    }), 2_000);
    expect(adDetectQueue.size).toBe(1);
  });

  test("公开警告在途时跨去重窗口不重复送检，警告后的新消息在结算后立即补排", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    let releaseWarning!: () => void;
    warnReferencedAdSender.mockImplementationOnce((): Promise<TelegramWorkerTemporaryMessageResult> =>
      new Promise<TelegramWorkerTemporaryMessageResult>(
        (resolve: (result: TelegramWorkerTemporaryMessageResult) => void): void => {
          releaseWarning = (): void => {
            // Telegram 已建立 555 号公开警告，但 HTTP 回执还没回来；用户此时发出的
            // 556/557 在群内顺序上明确晚于警告，本机接收时钟却早于回执 sentAt。
            enqueueAdCandidate(candidate({
              messageId: 556,
              text: "又来一条",
              sampleContext: { quote: "日入过千 加V same" },
            }), 2_000);
            enqueueAdCandidate(candidate({
              messageId: 557,
              text: "连续第三条",
              sampleContext: { quote: "日入过千 加V same" },
            }), 2_100);
            resolve({ messageId: 555, sentAt: 3_000 });
          };
        }
      ));
    enqueueAdCandidate(candidate({
      text: "第一次",
      sampleContext: { quote: "日入过千 加V same" },
    }), 1_000);

    const running: Promise<void> = runAdDetectBatch(1_000);
    await Bun.sleep(0);

    expect(warnReferencedAdSender).toHaveBeenCalledTimes(1);
    expect(inFlightAdDetectKeys.has("-1001:7")).toBe(true);
    expect(adDetectQueue.size).toBe(0);
    expect(classifyAdText).toHaveBeenCalledTimes(2);

    releaseWarning();
    await running;

    expect(inFlightAdDetectKeys.has("-1001:7")).toBe(false);
    expect(pendingAdMessages.get("-1001:7")?.entries.map((entry) => entry.messageId)).toEqual([556, 557]);
    expect(pendingAdMessages.get("-1001:7")?.entries[0]?.text)
      .toContain("日入过千 加V same");
    expect(adDetectQueue.size).toBe(1);

    await runAdDetectBatch(2_000);
    expect(warnReferencedAdSender).toHaveBeenCalledTimes(1);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
  });

  test("五分钟内再次命中引用类广告时走现有 block 路径", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    enqueueAdCandidate(candidate({
      text: "第一次",
      sampleContext: { quote: "日入过千 加V first" },
    }), 1_000);
    await runAdDetectBatch(1_000);

    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "第二次",
      sampleContext: { quote: "日入过千 加V second" },
    }), 2_000);
    await runAdDetectBatch(2_000);

    expect(warnReferencedAdSender).toHaveBeenCalledTimes(1);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    expect(referencedAdWarningStates.has("-1001:7")).toBe(false);
  });

  test("五分钟内到达的多次回复即使延迟到窗口外处理也会 block", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    enqueueAdCandidate(candidate({
      text: "第一次",
      sampleContext: { quote: "日入过千 加V first" },
    }), 1_000);
    await runAdDetectBatch(1_000);

    const receivedWithinWindow: number =
      1_000 + AD_REFERENCE_WARNING_WINDOW_MS - 1;
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "连续回复",
      sampleContext: { quote: "日入过千 加V again" },
    }), receivedWithinWindow);
    await runAdDetectBatch(
      1_000 + AD_REFERENCE_WARNING_WINDOW_MS + 60_000
    );

    expect(warnReferencedAdSender).toHaveBeenCalledTimes(1);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
  });

  test("五分钟窗口到期后再次命中会重新警告，不直接 block", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    enqueueAdCandidate(candidate({
      text: "第一次",
      sampleContext: { quote: "日入过千 加V first" },
    }), 1_000);
    await runAdDetectBatch(1_000);

    const afterWindow: number = 1_000 + AD_REFERENCE_WARNING_WINDOW_MS;
    setAdDetectWarningNow(afterWindow);
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "窗口后",
      sampleContext: { quote: "日入过千 加V later" },
    }), afterWindow);
    await runAdDetectBatch(afterWindow);

    expect(warnReferencedAdSender).toHaveBeenCalledTimes(2);
    expect(disposeAdSender).not.toHaveBeenCalled();
  });

  test("公开警告发送失败时不开启升级窗口", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    warnReferencedAdSender.mockImplementationOnce(async (): Promise<undefined> => undefined);
    enqueueAdCandidate(candidate({
      text: "看看",
      sampleContext: { quote: "日入过千 加V xxx996" },
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(referencedAdWarningStates.has("-1001:7")).toBe(false);
    expect(disposeAdSender).not.toHaveBeenCalled();
    expect(deleteReferencedAdMessages).toHaveBeenCalledTimes(1);
  });

  test("关开关时迟到的警告只撤提示，不留下窗口或继续删用户消息", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    let resolveWarning!: (result: TelegramWorkerTemporaryMessageResult) => void;
    warnReferencedAdSender.mockImplementationOnce((): Promise<TelegramWorkerTemporaryMessageResult> =>
      new Promise<TelegramWorkerTemporaryMessageResult>((resolve) => {
        resolveWarning = resolve;
      }));
    enqueueAdCandidate(candidate({
      text: "第一次",
      sampleContext: { quote: "日入过千 加V first" },
    }), 1_000);
    const running: Promise<void> = runAdDetectBatch(1_000);
    await Bun.sleep(0);

    clearChatAdDetect(-1001);
    resolveWarning({ messageId: 555, sentAt: 1_100 });
    await running;

    expect(referencedAdWarningStates.has("-1001:7")).toBeFalse();
    expect(deleteStaleReferencedAdWarning).toHaveBeenCalledWith(-1001, 555);
    expect(deleteReferencedAdMessages).not.toHaveBeenCalled();
  });

  test("手工转发的正文归属于来源，第一次命中只警告转发者", async () => {
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({
      isAd: true,
      reason: "转发广告",
    }));
    enqueueAdCandidate(candidate({
      text: "日入过千 加V origin",
      isForwarded: true,
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(classifiedTexts).toEqual(["1. 日入过千 加V origin"]);
    expect(warnReferencedAdSender).toHaveBeenCalledTimes(1);
    expect(disposeAdSender).not.toHaveBeenCalled();
  });

  test("命中后同窗口内抢跑进来的消息直接丢弃，不再攒出第二次处置", async () => {
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    // 处置标记由判定结算路径按本地时钟落下，读它的一侧必须用同一把钟——混用
    // 小逻辑时钟会被回拨判据当成时钟往回走，标记提前失效。
    const disposedAt: number = Date.now();
    enqueueAdCandidate(candidate({ messageId: 1, text: "USDT 承兑加我" }), disposedAt);
    await runAdDetectBatch(disposedAt);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    expect(recentlyDisposedAdKeys.has("-1001:7")).toBe(true);

    // 封禁还没落地时他还能再说几句；重判只会换来第二次完全相同的处置。
    const stragglerAt: number = Date.now() + 500;
    enqueueAdCandidate(candidate({ messageId: 2, text: "还有名额" }), stragglerAt);
    expect(pendingAdMessages.size).toBe(0);
    await runAdDetectBatch(stragglerAt);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    // 逐 key TTL 到期后抑制解除；此时主线程的黑名单门禁早已接管投递侧。
    expireAdDetectDisposalMarkers(Number.MAX_SAFE_INTEGER);
    expect(recentlyDisposedAdKeys.size).toBe(0);
  });

  test("命中后频道马甲抢跑进来的广告照样删掉", async () => {
    // banChatSenderChat 没有 revoke_messages，逐条删除是这些消息唯一的清理路径；
    // 判定到封禁落地之间还隔着回投主线程、名单 fsync 与 outbox 屏障。
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    // 同上：处置标记按本地时钟落下，抢跑消息也用本地时钟读。
    const disposedAt: number = Date.now();
    enqueueAdCandidate(candidate({ senderId: -1005, isChannel: true, messageId: 1, text: "USDT 承兑" }), disposedAt);
    await runAdDetectBatch(disposedAt);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    const stragglerAt: number = Date.now() + 500;
    enqueueAdCandidate(candidate({ senderId: -1005, isChannel: true, messageId: 2, text: "还有名额" }), stragglerAt);
    expect(deleteStragglerAdMessage).toHaveBeenCalledWith(-1001, 2);
    // 仍然不重判、不重新处置：那一套只该走一次。
    expect(pendingAdMessages.size).toBe(0);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    // 真人目标走 revoke_messages，不需要这条补删。
    enqueueAdCandidate(candidate({ messageId: 3, text: "加我微信" }), stragglerAt);
    await runAdDetectBatch(stragglerAt);
    expect(deleteStragglerAdMessage).toHaveBeenCalledTimes(1);
  });

  test("封禁确定完成只释放处置标记，不碰同一个人新取得的待检位置", () => {
    // 同一个人在封禁落地前又说了话：那一串已经重新排上队，释放处置标记不能
    // 把它的队列位置一起带走，否则这批新内容永远等不到判定。
    recentlyDisposedAdKeys.set("-1001:7", Date.now());
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);

    releaseAdDetectDedupKey(-1001, 7);

    expect(queuedAdDetectKeys.has("-1001:7")).toBe(true);
    expect(adDetectQueue.size).toBe(1);
    expect(recentlyDisposedAdKeys.has("-1001:7")).toBe(false);
  });

  test("没有广告处置标记时不释放：手工封禁不能误拆待检 bundle 的 TTL", () => {
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);

    releaseAdDetectDedupKey(-1001, 7);

    expect(queuedAdDetectKeys.has("-1001:7")).toBe(true);
    expect(pendingAdMessages.has("-1001:7")).toBe(true);
  });

  test("已拉黑的频道马甲跨窗口照样删，不占判定额度", () => {
    // recentlyDisposedAdKeys 只活一个去重窗口，而「已拉黑但封禁没落地」可以跨
    // 窗口存在（秒踢、补扫、上个窗口判定登记的封禁批次都是先写名单再等 outbox
    // 落盘与 mailbox 屏障）。该 key TTL 到期后就只剩 blocked 这一个判据认得它。
    expireAdDetectDisposalMarkers();
    expect(recentlyDisposedAdKeys.size).toBe(0);

    enqueueAdCandidate(candidate({
      senderId: -1006,
      isChannel: true,
      blocked: true,
      messageId: 4,
      text: "换汇加我",
    }), 2_000);

    expect(deleteStragglerAdMessage).toHaveBeenCalledWith(-1001, 4);
    expect(pendingAdMessages.has("-1001:-1006")).toBe(false);
    expect(adDetectQueue.size).toBe(0);
  });

  test("群管理员即使被判成广告也不处置", async () => {
    // 处置与 /block 同权且不可逆：永久黑名单 + 每个托管群封禁 + revoke_messages
    // 抹掉近期消息，恢复要人工 /unblock 再逐群解封。
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    fetchedAdmins.set(-1001, new Set([7]));
    enqueueAdCandidate(candidate({ messageId: 1, text: "看我合作方的链接" }), 1_000);

    await runAdDetectBatch(1_000);
    expect(disposeAdSender).not.toHaveBeenCalled();
    expect(pendingAdMessages.size).toBe(0);
  });

  test("管理员表查不出来时保守放过，不赌一次不可逆处置", async () => {
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    fetchedAdmins.delete(-1001);
    enqueueAdCandidate(candidate({ messageId: 1, text: "USDT 承兑加我" }), 1_000);

    await runAdDetectBatch(1_000);
    expect(disposeAdSender).not.toHaveBeenCalled();
  });

  test("缓存已知的管理员连送检都不送，不白烧额度", async () => {
    cachedAdmins.set(-1001, new Set([7]));
    enqueueAdCandidate(candidate({ messageId: 1, text: "加我微信" }), 1_000);
    expect(pendingAdMessages.size).toBe(0);

    await runAdDetectBatch(1_000);
    expect(classifyAdText).not.toHaveBeenCalled();
    // 缓存里的普通成员照常入队。
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 2 }), 1_000);
    expect(pendingAdMessages.size).toBe(1);
  });
});
