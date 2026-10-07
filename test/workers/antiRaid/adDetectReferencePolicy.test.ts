import { beforeEach, describe, expect, test } from "bun:test";
import type {
  AdVerdict,
  AdVerdictTrueEvent,
} from "../../../packages/types/antiRaid/adDetect";
import type { TelegramWorkerTemporaryMessageResult } from "../../../packages/types/telegramWorker";
import {
  cachedAdmins,
  candidate,
  classifiedTexts,
  classifyAdText,
  deleteReferencedAdMessages,
  deleteMessage,
  deleteStragglerAdMessage,
  disposeAdSender,
  errorLogs,
  fetchedAdmins,
  resetAdDetectQueueHarness,
  setAdDetectWarningNow,
  warnReferencedAdSender,
} from "../../helpers/adDetectQueueHarness";

const { telegramApi } = await import("../../../packages/infra/telegram");
const {
  clearChatAdDetect,
  enqueueAdCandidate,
  runAdDetectBatch,
  stopAdDetectQueue,
} = await import("../../../packages/workers/antiRaid/adDetect/queue");
const { expireAdDetectDisposalMarkers, releaseAdDetectDedupKey } =
  await import("../../../packages/workers/antiRaid/adDetect/queueState");
const {
  adDetectQueue,
  adVerdictTruePublishHolder,
  inFlightAdDetectKeys,
  pendingAdBundleCount,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
  referencedAdWarningGeneration,
  referencedAdWarningStates,
} = await import("../../../packages/cache/workers/antiRaid/adDetect");
const {
  AD_DETECT_MAX_PENDING_SENDERS,
  AD_REFERENCE_WARNING_WINDOW_MS,
} = await import("../../../packages/consts/antiRaid/adDetect");
const {
  beginReferencedAdWarning,
  clearIdentityReferencedAdWarnings,
  completeReferencedAdWarning,
  sweepReferencedAdWarnings,
} = await import("../../../packages/workers/antiRaid/adDetect/referencePolicy");

/**
 * attempt 序号只增不减（resetReferencedAdWarnings 不重置它，见该函数头注），
 * 顶层 beforeEach 把它归零。
 */
const { pendingAdBundle } =
  await import("../../../packages/workers/antiRaid/adDetect/queueState");
beforeEach((): void => {
  resetAdDetectQueueHarness(stopAdDetectQueue);
  referencedAdWarningGeneration.current = 0;
});

describe("引用类广告的警告升级与处置抑制", () => {
  test("引用类广告第一次只公开警告并清串，警告后下一条可立即重新判定", async () => {
    const verdictEvents: AdVerdictTrueEvent[] = [];
    adVerdictTruePublishHolder.current = (event: AdVerdictTrueEvent): void => {
      verdictEvents.push(event);
    };
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    enqueueAdCandidate(candidate({
      text: "这种广告真烦",
      sampleQuote: "日入过千 加V xxx996",
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(classifiedTexts).toEqual([
      "1. 这种广告真烦 日入过千 加V xxx996",
      "1. 这种广告真烦",
    ]);
    expect(warnReferencedAdSender).toHaveBeenCalledTimes(1);
    expect(disposeAdSender).not.toHaveBeenCalled();
    expect(verdictEvents).toEqual([{
      type: "adVerdictTrue",
      chatId: -1001,
      senderId: 7,
    }]);
    expect(referencedAdWarningStates.get("-1001:7")).toMatchObject({
      phase: "warned",
      warnedAt: 1_000,
      expiresAt: 1_000 + AD_REFERENCE_WARNING_WINDOW_MS,
    });
    expect(pendingAdBundle(-1001, 7) !== undefined).toBe(false);
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(false);

    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "又来一条",
      sampleReplyTo: "日入过千 加V second",
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
              sampleQuote: "日入过千 加V same",
            }), 2_000);
            enqueueAdCandidate(candidate({
              messageId: 557,
              text: "连续第三条",
              sampleQuote: "日入过千 加V same",
            }), 2_100);
            resolve({ messageId: 555, sentAt: 3_000 });
          };
        }
      ));
    enqueueAdCandidate(candidate({
      text: "第一次",
      sampleQuote: "日入过千 加V same",
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
    expect(pendingAdBundle(-1001, 7)?.entries.map((entry) => entry.messageId)).toEqual([556, 557]);
    expect(pendingAdBundle(-1001, 7)?.entries[0]?.text)
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
      sampleQuote: "日入过千 加V first",
    }), 1_000);
    await runAdDetectBatch(1_000);

    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "第二次",
      sampleQuote: "日入过千 加V second",
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
      sampleQuote: "日入过千 加V first",
    }), 1_000);
    await runAdDetectBatch(1_000);

    const receivedWithinWindow: number =
      1_000 + AD_REFERENCE_WARNING_WINDOW_MS - 1;
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "连续回复",
      sampleQuote: "日入过千 加V again",
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
      sampleQuote: "日入过千 加V first",
    }), 1_000);
    await runAdDetectBatch(1_000);

    const afterWindow: number = 1_000 + AD_REFERENCE_WARNING_WINDOW_MS;
    setAdDetectWarningNow(afterWindow);
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "窗口后",
      sampleQuote: "日入过千 加V later",
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
      sampleQuote: "日入过千 加V xxx996",
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(referencedAdWarningStates.has("-1001:7")).toBe(false);
    expect(disposeAdSender).not.toHaveBeenCalled();
    expect(deleteReferencedAdMessages).toHaveBeenCalledTimes(1);
  });

  test("公开警告发送抛错时记错误，不开启升级窗口但仍删除引用广告", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    warnReferencedAdSender.mockImplementationOnce(async (): Promise<never> => {
      throw new Error("warning send exploded");
    });
    enqueueAdCandidate(candidate({
      text: "看看",
      sampleQuote: "日入过千 加V xxx996",
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(errorLogs.some((line: string): boolean =>
      line.includes("failed to send referenced-ad warning")
    )).toBeTrue();
    expect(referencedAdWarningStates.has("-1001:7")).toBe(false);
    expect(inFlightAdDetectKeys.has("-1001:7")).toBe(false);
    expect(disposeAdSender).not.toHaveBeenCalled();
    expect(deleteReferencedAdMessages).toHaveBeenCalledTimes(1);
  });

  test("主线程发现临时广告豁免时不警告、不删消息并丢弃旧待检串", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"),
      reason: "引用内容引流",
    }));
    warnReferencedAdSender.mockImplementationOnce(
      async (): Promise<TelegramWorkerTemporaryMessageResult> => ({ suppressed: true })
    );
    enqueueAdCandidate(candidate({
      text: "看看",
      sampleQuote: "日入过千 加V xxx996",
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(referencedAdWarningStates.has("-1001:7")).toBeFalse();
    expect(pendingAdBundle(-1001, 7) !== undefined).toBeFalse();
    expect(queuedAdDetectKeys.has("-1001:7")).toBeFalse();
    expect(deleteReferencedAdMessages).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(disposeAdSender).not.toHaveBeenCalled();
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
      sampleQuote: "日入过千 加V first",
    }), 1_000);
    const running: Promise<void> = runAdDetectBatch(1_000);
    await Bun.sleep(0);

    clearChatAdDetect(-1001);
    resolveWarning({ messageId: 555, sentAt: 1_100 });
    await running;

    expect(referencedAdWarningStates.has("-1001:7")).toBeFalse();
    expect(deleteMessage).toHaveBeenCalledWith(-1001, 555, telegramApi);
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
    // 处置标记由判定结算路径按本地时钟落下，读取一侧使用同一把钟。
    const disposedAt: number = Date.now();
    enqueueAdCandidate(candidate({ messageId: 1, text: "USDT 承兑加我" }), disposedAt);
    await runAdDetectBatch(disposedAt);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    expect(recentlyDisposedAdKeys.has("-1001:7")).toBe(true);

    // 封禁还没落地时他还能再说几句；这些消息直接丢弃，不重判。
    const stragglerAt: number = Date.now() + 500;
    enqueueAdCandidate(candidate({ messageId: 2, text: "还有名额" }), stragglerAt);
    expect(pendingAdBundleCount.current).toBe(0);
    await runAdDetectBatch(stragglerAt);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    // 逐 key TTL 到期后抑制解除；此时主线程的黑名单门禁早已接管投递侧。
    expireAdDetectDisposalMarkers(Number.MAX_SAFE_INTEGER);
    expect(recentlyDisposedAdKeys.size).toBe(0);
  });

  test("命中后频道马甲抢跑进来的广告照样删掉", async () => {
    // banChatSenderChat 没有 revoke_messages，逐条删除是这些消息唯一的清理路径。
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    // 同上：处置标记按本地时钟落下，抢跑消息也用本地时钟读。
    const disposedAt: number = Date.now();
    enqueueAdCandidate(candidate({ senderId: -1005, isChannel: true, messageId: 1, text: "USDT 承兑" }), disposedAt);
    await runAdDetectBatch(disposedAt);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    const stragglerAt: number = Date.now() + 500;
    enqueueAdCandidate(candidate({ senderId: -1005, isChannel: true, messageId: 2, text: "还有名额" }), stragglerAt);
    expect(deleteStragglerAdMessage).toHaveBeenCalledWith(-1001, 2);
    // 仍然不重判、不重新处置。
    expect(pendingAdBundleCount.current).toBe(0);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    // 真人目标走 revoke_messages，不需要这条补删。
    enqueueAdCandidate(candidate({ messageId: 3, text: "加我微信" }), stragglerAt);
    await runAdDetectBatch(stragglerAt);
    expect(deleteStragglerAdMessage).toHaveBeenCalledTimes(1);
  });

  test("封禁确定完成只释放处置标记，不碰同一个人新取得的待检位置", () => {
    // 同一个人在封禁落地前又说了话：那一串已经重新排上队；释放处置标记不带走它的队列位置。
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
    expect(pendingAdBundle(-1001, 7) !== undefined).toBe(true);
  });

  test("已拉黑的频道马甲跨窗口照样删，不占判定额度", () => {
    // recentlyDisposedAdKeys 只活一个去重窗口，「已拉黑但封禁没落地」可以跨窗口存在；
    // 该 key TTL 到期后只剩 blocked 判据认得它。
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
    expect(pendingAdBundle(-1001, -1006) !== undefined).toBe(false);
    expect(adDetectQueue.size).toBe(0);
  });

  test("群管理员即使被判成广告也不处置", async () => {
    // 群管理员被判成广告也不处置，不触发与 /block 同权的永久黑名单与逐群封禁。
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    fetchedAdmins.set(-1001, new Set([7]));
    enqueueAdCandidate(candidate({ messageId: 1, text: "看我合作方的链接" }), 1_000);

    await runAdDetectBatch(1_000);
    expect(disposeAdSender).not.toHaveBeenCalled();
    expect(pendingAdBundleCount.current).toBe(0);
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
    expect(pendingAdBundleCount.current).toBe(0);

    await runAdDetectBatch(1_000);
    expect(classifyAdText).not.toHaveBeenCalled();
    // 缓存里的普通成员照常入队。
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 2 }), 1_000);
    expect(pendingAdBundleCount.current).toBe(1);
  });

  /**
   * 已知管理员这道闸在 enqueueAdCandidate 里排在正文清洗之前（见那边的注释）。
   * 下面四条验证提前返回不改变各种身份组合（isChannel / blocked / recentlyDisposed / 串里已有内容）的结局。
   */
  test("中途被提为管理员：新消息被忽略，既有消息串原样不动", async () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "先说一句正常的" }), 1_000);
    expect(pendingAdBundle(-1001, 7)?.entries).toHaveLength(1);

    cachedAdmins.set(-1001, new Set([7]));
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "提为管理员之后又说一句",
      sampleQuote: "被引用的一段原文",
      sampleReplyTo: "被回复的一段原文",
    }), 1_100);

    // 既不新增条目，也不改写既有条目。
    const bundle = pendingAdBundle(-1001, 7);
    expect(bundle?.entries).toHaveLength(1);
    expect(bundle?.entries[0]?.messageId).toBe(1);
    expect(bundle?.nextSeq).toBe(2);
  });

  test("管理员豁免只认用户身份：频道马甲不因同 id 出现在管理员表而放行", async () => {
    // 频道 id 是负数，正常不会进管理员表；这里塞进去，确认判据是 isChannel 而不是 id 在不在表里。频道马甲照常入队送检。
    cachedAdmins.set(-1001, new Set([-1005]));
    enqueueAdCandidate(candidate({
      senderId: -1005,
      isChannel: true,
      messageId: 1,
      text: "换汇加我",
    }), 1_000);

    expect(pendingAdBundle(-1001, -1005) !== undefined).toBe(true);
  });

  test("已拉黑的管理员按用户身份忽略，不走频道尾随删除", async () => {
    cachedAdmins.set(-1001, new Set([7]));
    enqueueAdCandidate(candidate({ blocked: true, messageId: 1, text: "加我微信" }), 1_000);

    expect(deleteStragglerAdMessage).not.toHaveBeenCalled();
    expect(pendingAdBundleCount.current).toBe(0);
  });

  test("管理员的空白正文与普通空白正文结局一致，都不入队", () => {
    // 主线程清洗后的空白正文就是空串（见 antiRaid/adCandidate.ts）。
    cachedAdmins.set(-1001, new Set([7]));
    enqueueAdCandidate(candidate({ messageId: 1, text: "" }), 1_000);
    expect(pendingAdBundleCount.current).toBe(0);

    cachedAdmins.clear();
    enqueueAdCandidate(candidate({ messageId: 2, text: "" }), 1_000);
    expect(pendingAdBundleCount.current).toBe(0);
  });
});

/**
 * 上面那组走队列集成路径，referencePolicy 的容量闸、按身份清理和周期回收三段
 * 在其中不会遇到非空表。这里直接驱动这些纯函数，验证各自的不变量；
 * 每条都先把表填成有匹配条目的状态再调用。
 */
describe("引用广告警告状态表自身的容量与回收", () => {
  /** 造一条已进入五分钟窗口的 warned 记录，绕开发送链路直接落表。 */
  function warned(key: string, warnedAt: number): void {
    const generation: number | undefined = beginReferencedAdWarning(key);
    expect(generation).toBeDefined();
    expect(completeReferencedAdWarning(key, generation!, warnedAt)).toBeTrue();
  }

  test("attempt 序号耗尽时拒绝建立新警告，并记一条错误", () => {
    referencedAdWarningGeneration.current = Number.MAX_SAFE_INTEGER;

    expect(beginReferencedAdWarning("-1001:7")).toBeUndefined();

    // 既不占表，也不把序号推过安全整数边界。
    expect(referencedAdWarningStates.has("-1001:7")).toBeFalse();
    expect(referencedAdWarningGeneration.current).toBe(Number.MAX_SAFE_INTEGER);
    expect(errorLogs).toContain("Referenced ad warning generation space is exhausted.");
  });

  test("表满时按插入序淘汰最早一条，为新警告腾出名额", () => {
    for (let index: number = 0; index < AD_DETECT_MAX_PENDING_SENDERS; index += 1) {
      expect(beginReferencedAdWarning(`-1001:${index}`)).toBeDefined();
    }
    expect(referencedAdWarningStates.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);

    expect(beginReferencedAdWarning("-1001:newcomer")).toBeDefined();

    // 淘汰的是插入序最早的那条；总量不越硬顶。
    expect(referencedAdWarningStates.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(referencedAdWarningStates.has("-1001:0")).toBeFalse();
    expect(referencedAdWarningStates.has("-1001:1")).toBeTrue();
    expect(referencedAdWarningStates.has("-1001:newcomer")).toBeTrue();
  });

  test("同一个 key 重新警告不占新名额，也不淘汰别人", () => {
    for (let index: number = 0; index < AD_DETECT_MAX_PENDING_SENDERS; index += 1) {
      expect(beginReferencedAdWarning(`-1001:${index}`)).toBeDefined();
    }

    // 表满且键已存在：先 delete 再 set，净增为零，不触发淘汰分支。
    expect(beginReferencedAdWarning("-1001:0")).toBeDefined();

    expect(referencedAdWarningStates.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(referencedAdWarningStates.has("-1001:0")).toBeTrue();
    expect(referencedAdWarningStates.has("-1001:1")).toBeTrue();
  });

  test("身份获得白名单后清掉它在各群的警告，只动这一个 id", () => {
    warned("-1001:7", 1_000);
    warned("-2002:7", 1_000);
    warned("-1001:8", 1_000);

    clearIdentityReferencedAdWarnings(7);

    expect(referencedAdWarningStates.has("-1001:7")).toBeFalse();
    expect(referencedAdWarningStates.has("-2002:7")).toBeFalse();
    // 同群别人的窗口不受影响。
    expect(referencedAdWarningStates.has("-1001:8")).toBeTrue();
  });

  test("周期回收丢掉过期窗口，保留仍在窗口内的", () => {
    warned("-1001:expired", 1_000);
    warned("-1001:fresh", 1_000 + AD_REFERENCE_WARNING_WINDOW_MS);

    sweepReferencedAdWarnings(1_000 + AD_REFERENCE_WARNING_WINDOW_MS);

    // 半开窗口：now 恰好等于 expiresAt 即已出局。
    expect(referencedAdWarningStates.has("-1001:expired")).toBeFalse();
    expect(referencedAdWarningStates.has("-1001:fresh")).toBeTrue();
  });

  test("墙钟回拨到警告之前时也回收，不把五分钟窗口拉长", () => {
    warned("-1001:7", 5_000);

    sweepReferencedAdWarnings(4_000);

    expect(referencedAdWarningStates.has("-1001:7")).toBeFalse();
  });

  test("周期回收不碰仍在发送中的 attempt", () => {
    // sending 态由发送结算、清群或 Worker 停止负责，回收路径必须原样放过。
    expect(beginReferencedAdWarning("-1001:sending")).toBeDefined();

    sweepReferencedAdWarnings(Number.MAX_SAFE_INTEGER);

    expect(referencedAdWarningStates.get("-1001:sending")).toMatchObject({ phase: "sending" });
  });
});
