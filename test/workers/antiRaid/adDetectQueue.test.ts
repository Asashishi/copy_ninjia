import { beforeEach, describe, expect, test } from "bun:test";
import type { AdCandidateMessage, AdDetectedEvent } from "../../../packages/types/antiRaid";
import type { AdVerdict } from "../../../packages/types/antiRaid/adDetect";
import {
  candidate,
  classifiedFacts,
  classifiedTexts,
  classifyAdText,
  disposeAdSender,
  errorLogs,
  resetAdDetectQueueHarness,
  warnReferencedAdSender,
} from "../../helpers/adDetectQueueHarness";

const {
  clearChatAdDetect,
  enqueueAdCandidate,
  expireAdDetectDisposalMarkers,
  quiesceAdDetectQueue,
  runAdDetectBatch,
  startAdDetectQueue,
  stopAdDetectQueue,
  sweepAdDetect,
} = await import("../../../packages/workers/antiRaid/adDetect/queue");
const { antiRaidInFlightTasks } = await import("../../../packages/cache/workers/antiRaid/tasks");
const {
  adDetectPublishHolder,
  adDetectQueue,
  adDetectTickTimer,
  inFlightAdDetectKeys,
  inFlightReferencedAdCleanupTasks,
  pendingAdMessages,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
  referencedAdWarningStates,
} = await import("../../../packages/cache/workers/antiRaid/adDetect");
const {
  AD_DETECT_BATCH_SIZE,
  AD_DETECT_JUDGED_RETENTION_WINDOW_MS,
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_MESSAGES_PER_SENDER,
  AD_DETECT_MAX_PENDING_SENDERS,
  AD_DETECT_MESSAGE_MAX_CHARS,
} = await import("../../../packages/consts/antiRaid/adDetect");

beforeEach((): void => resetAdDetectQueueHarness(stopAdDetectQueue));

/**
 * 「谁在待检」只有一个答案：queuedAdDetectKeys 必须与 adDetectQueue 的内容逐键
 * 一致，且同一个键在队列里最多占一个位置。
 *
 * 去重、容量与补排判据现在全部落在这一张表上（曾经并行的 TTL 认领表已删除），
 * 它一旦和队列失配，要么同一个人吃掉两份判定额度，要么未判内容永远排不回来。
 */
function expectQueueOwnershipConsistent(): void {
  const queued: string[] = adDetectQueue.last(adDetectQueue.size);
  expect(new Set<string>(queued).size).toBe(queued.length);
  expect(queuedAdDetectKeys.size).toBe(queued.length);
  for (const key of queued) expect(queuedAdDetectKeys.has(key)).toBe(true);
  expect(queuedAdDetectKeys.size).toBeLessThanOrEqual(pendingAdMessages.size);
}

describe("广告判定队列：排队、调度与位置所有权", () => {
  test("队列只排键，同一个人的多条消息并进同一串", () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "加我" }), 1_000);
    enqueueAdCandidate(candidate({ messageId: 2, text: "微信" }), 1_500);
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 3 }), 1_600);

    expect(adDetectQueue.size).toBe(2);
    expect([...queuedAdDetectKeys]).toEqual(["-1001:7", "-1001:8"]);
    expect(pendingAdMessages.get("-1001:7")?.entries.map((entry) => entry.messageId)).toEqual([1, 2]);
  });

  test("justJoined 在消息串里取并集，后续消息不能把它洗掉", () => {
    // 验证会在窗口内通过：先发广告、后点验证的人不该因此洗白。
    enqueueAdCandidate(candidate({ messageId: 1, justJoined: true }), 1_000);
    enqueueAdCandidate(candidate({ messageId: 2, justJoined: false }), 1_100);
    expect(pendingAdMessages.get("-1001:7")?.justJoined).toBe(true);
  });

  test("送检时把 justJoined 一起交给判定器", async () => {
    enqueueAdCandidate(candidate({ messageId: 1, justJoined: true }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifiedFacts).toEqual([true]);
  });

  test("空正文不入队，超长正文按上限截断", () => {
    enqueueAdCandidate(candidate({ text: "   " }));
    expect(pendingAdMessages.size).toBe(0);

    enqueueAdCandidate(candidate({ text: "x".repeat(AD_DETECT_MESSAGE_MAX_CHARS + 50) }));
    expect(pendingAdMessages.get("-1001:7")?.entries[0]?.text).toHaveLength(AD_DETECT_MESSAGE_MAX_CHARS);
  });

  test("自身去重 TTL 外已消费的旧上下文会裁掉，新消息仍算未判定", () => {
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    const bundle = pendingAdMessages.get("-1001:7")!;
    bundle.checkedSeq = 1;

    enqueueAdCandidate(candidate({ messageId: 2 }), 1_000 + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1);
    expect(bundle.entries.map((entry) => entry.messageId)).toEqual([2]);
    // 序号单调递增，裁剪不回退它：新那条的 seq 比 checkedSeq 大，照样要判。
    expect(bundle.entries[0]?.seq).toBe(2);
    expect(bundle.checkedSeq).toBe(1);
  });

  test("在途判定期间旧条目仍算未消费，结算后才可按序号裁掉", async () => {
    // 判定返回前 checkedSeq 还没推进，哪怕等待超过窗口也不能裁掉这批在途条目；
    // 返回后按 captured seq 结算，之后的新消息仍保持未判定。
    let release!: (verdict: AdVerdict) => void;
    classifyAdText.mockImplementationOnce((): Promise<AdVerdict> => new Promise<AdVerdict>((resolve) => {
      release = resolve;
    }));
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    enqueueAdCandidate(candidate({ messageId: 2 }), 1_100);
    const running: Promise<void> = runAdDetectBatch(1_100);

    const late: number = 1_100 + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1;
    enqueueAdCandidate(candidate({ messageId: 3, text: "加我微信" }), late);
    enqueueAdCandidate(candidate({ messageId: 4, text: "带你上岸" }), late);
    const bundle = pendingAdMessages.get("-1001:7")!;
    expect(bundle.entries.map((entry) => entry.messageId)).toEqual([1, 2, 3, 4]);

    release({ isAd: false, reason: "" });
    await running;
    expect(bundle.checkedSeq).toBe(2);

    // 结算时 requeueIfUnchecked 已经把未判内容排进下一批，不靠任何周期回收推动。
    expect(adDetectQueue.size).toBe(1);
    await runAdDetectBatch(late);
    expect(classifiedTexts[1]).toBe("1. 加我微信\n2. 带你上岸");
  });

  test("单个键的消息条数与键总数都有上界", () => {
    for (let index: number = 0; index <= AD_DETECT_MAX_MESSAGES_PER_SENDER; index++) {
      enqueueAdCandidate(candidate({ messageId: index + 1 }), 1_000 + index);
    }
    const entries = pendingAdMessages.get("-1001:7")!.entries;
    expect(entries).toHaveLength(AD_DETECT_MAX_MESSAGES_PER_SENDER);
    expect(entries[0]?.messageId).toBe(2);
    expect(pendingAdMessages.get("-1001:7")?.pendingDeleteIds).toEqual([1]);

    for (let index: number = 0; index < AD_DETECT_MAX_PENDING_SENDERS + 5; index++) {
      enqueueAdCandidate(candidate({ senderId: 1_000 + index }));
    }
    expect(pendingAdMessages.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(adDetectQueue.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(queuedAdDetectKeys.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(pendingAdMessages.has(`-1001:${1_000 + AD_DETECT_MAX_PENDING_SENDERS + 4}`)).toBe(false);
  });

  test("已接纳 key 等待超过去重窗口仍会获得首次判定", async () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "排队中的广告" }), 1_000);

    await runAdDetectBatch(1_000 + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1);

    expect(classifiedTexts).toEqual(["1. 排队中的广告"]);
    expect(pendingAdMessages.get("-1001:7")?.checkedSeq).toBe(1);
  });

  test("判定抛错按「本次没判定」结算：记一行日志、推进水位，不静默死循环", async () => {
    // classifyAdText 的同步准备阶段也会抛：它先调 adDetectSystemPrompt →
    // getAdSampleConfig()，而后者只缓存成功结果——进程启动之后把
    // config/ad_samples.json 改坏，每一次调用都重新抛同一个错。不接住的话异常
    // 一路逃到 runAdDetectBatch 的 Promise.allSettled 被整个吞掉：checkedSeq
    // 永不推进，之后每条新发言都会把同一批旧内容带回来再次失败，全程一行日志
    // 都没有，而 /ad_detect 仍然报告功能已启用。
    classifyAdText.mockImplementationOnce((): Promise<AdVerdict | null> => {
      throw new Error("config/ad_samples.json must contain a JSON object.");
    });
    enqueueAdCandidate(candidate({ messageId: 1, text: "加我微信" }), 1_000);

    await runAdDetectBatch(1_000);

    expect(errorLogs.some((line: string): boolean => line.includes("failed to classify sender 7 in chat -1001"))).toBeTrue();
    // 与「模型抽风、响应形状不对」同一档：本次记成已检，不重试成请求风暴。
    expect(pendingAdMessages.get("-1001:7")?.checkedSeq).toBe(1);
    // in-flight 标记照常释放，这个键不会被永久钉住。
    expect(inFlightAdDetectKeys.size).toBe(0);
    expect(disposeAdSender).not.toHaveBeenCalled();
  });

  test("全局在途闸撑满时不再派发，被挡下的键留在队列里而不是凭空消失", async () => {
    // 批大小只限每拍起多少个，拦不住「上一批还没回来就再起一批」：DeepSeek 一慢，
    // 在途请求就按派发速率乘单次耗时堆积，每个都钉住自己那一串消息。
    let release!: () => void;
    const blocked = new Promise<AdVerdict | null>((resolve: (verdict: AdVerdict | null) => void): void => {
      release = (): void => resolve({ isAd: false, reason: "" });
    });
    classifyAdText.mockImplementation((): Promise<AdVerdict | null> => blocked);

    const senders: number = AD_DETECT_MAX_IN_FLIGHT + AD_DETECT_BATCH_SIZE;
    for (let index: number = 0; index < senders; index++) {
      enqueueAdCandidate(candidate({ senderId: index + 1 }));
    }
    // 一直派发到撑满为止：每拍最多 AD_DETECT_BATCH_SIZE 个，谁都不返回。
    for (let tick: number = 0; tick < Math.ceil(senders / AD_DETECT_BATCH_SIZE); tick++) {
      void runAdDetectBatch();
      await Bun.sleep(0);
    }

    expect(inFlightAdDetectKeys.size).toBe(AD_DETECT_MAX_IN_FLIGHT);
    // 判断排在 shift 之前，所以挡下的键还在队列里等下一拍，没有被取出来丢掉。
    expect(adDetectQueue.size).toBe(senders - AD_DETECT_MAX_IN_FLIGHT);
    expect(queuedAdDetectKeys.size).toBe(senders - AD_DETECT_MAX_IN_FLIGHT);

    release();
    await Bun.sleep(0);
  });

  test("一个节拍最多取一批键，剩下的留在队首等下一拍", async () => {
    for (let index: number = 0; index < AD_DETECT_BATCH_SIZE + 3; index++) {
      enqueueAdCandidate(candidate({ senderId: index + 1 }));
    }

    await runAdDetectBatch();
    expect(classifyAdText).toHaveBeenCalledTimes(AD_DETECT_BATCH_SIZE);
    expect(adDetectQueue.size).toBe(3);

    await runAdDetectBatch();
    expect(classifyAdText).toHaveBeenCalledTimes(AD_DETECT_BATCH_SIZE + 3);
    expect(adDetectQueue.size).toBe(0);
  });

  test("批次派发即释放入队 key，后续内容直接形成下一批", async () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "在吗" }), 1_000);
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(true);
    await runAdDetectBatch(1_000);
    expect(classifiedTexts).toEqual(["1. 在吗"]);
    expect(adDetectQueue.size).toBe(0);
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(false);
    expect(pendingAdMessages.get("-1001:7")?.checkedSeq).toBe(1);

    // 同一串没有新内容时不该被重复判定，否则每一拍都在重烧同一条消息。
    await runAdDetectBatch(1_000);
    expect(classifyAdText).toHaveBeenCalledTimes(1);

    // 派发已经释放旧认领：下一条取得一个新队列位置，随后消息继续并入该批。
    enqueueAdCandidate(candidate({ messageId: 2, text: "加我微信" }), 2_000);
    enqueueAdCandidate(candidate({ messageId: 3, text: "带你上岸" }), 3_000);
    expect(adDetectQueue.size).toBe(1);
    await runAdDetectBatch(3_000);
    expect(classifyAdText).toHaveBeenCalledTimes(2);
    expect(classifiedTexts[1]).toBe("1. 在吗\n2. 加我微信\n3. 带你上岸");
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(false);
  });

  test("派发释放 key 不会给没有新内容的 bundle 白排一次判定", async () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "在吗" }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifyAdText).toHaveBeenCalledTimes(1);
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(false);

    expect(adDetectQueue.size).toBe(0);
    await runAdDetectBatch(1_000);
    expect(classifyAdText).toHaveBeenCalledTimes(1);
  });

  test("待检位置没有等待 TTL：排多久都不过期，也不产生副本", async () => {
    // 已接纳的键在发生至少一次判定尝试前不能因为等太久而消失（见
    // docs/cn/04-invariants.md）。位置由 queuedAdDetectKeys 独家表达，没有计时器
    // 能把它收走——曾经并行的认领 TTL 到期只会删认领、留下键继续排着。
    const firstAt: number = 1_000;
    const secondAt: number = 2_000;
    enqueueAdCandidate(candidate({ senderId: 7, messageId: 1 }), firstAt);
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 2 }), secondAt);
    expect(adDetectQueue.size).toBe(2);
    expectQueueOwnershipConsistent();

    const longAfter: number = firstAt + AD_DETECT_JUDGED_RETENTION_WINDOW_MS * 10;
    sweepAdDetect(longAfter);
    expect(adDetectQueue.size).toBe(2);
    expect(adDetectQueue.peek()).toBe("-1001:7");
    expectQueueOwnershipConsistent();

    await runAdDetectBatch(longAfter);
    expect(classifyAdText).toHaveBeenCalledTimes(2);
    expect(adDetectQueue.size).toBe(0);
    expect(queuedAdDetectKeys.size).toBe(0);
  });

  test("判成广告即摘掉整串并交给处置，不再重新排队", async () => {
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    enqueueAdCandidate(candidate({ messageId: 1, text: "USDT 承兑加我" }), 1_000);

    await runAdDetectBatch(1_000);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ bundle, verdict }] = disposeAdSender.mock.calls[0] as [{ bundle: { senderId: number }; verdict: AdVerdict }];
    expect(bundle.senderId).toBe(7);
    expect(verdict).toEqual({ isAd: true, reason: "引流" });
    expect(pendingAdMessages.size).toBe(0);
    expect(adDetectQueue.size).toBe(0);
  });

  test("直接正文命中时即使带回复上下文也沿用现有 block 路径", async () => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("加V direct"),
      reason: "直接引流",
    }));
    enqueueAdCandidate(candidate({
      text: "日入过千 加V direct",
      sampleContext: { quote: "转发来的广告" },
    }), 1_000);

    await runAdDetectBatch(1_000);

    // 先按现有整串口径命中，再只看本人正文确认归因；直接广告仍立刻 block。
    expect(classifiedTexts).toEqual([
      "1. 日入过千 加V direct 转发来的广告",
      "1. 日入过千 加V direct",
    ]);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    expect(warnReferencedAdSender).not.toHaveBeenCalled();
  });

  test("直接正文归因返回未知时不伪装成引用类命中", async () => {
    let classifyCount: number = 0;
    classifyAdText.mockImplementation(async (): Promise<AdVerdict | null> => {
      classifyCount++;
      return classifyCount === 1
        ? { isAd: true, reason: "整串命中" }
        : null;
    });
    enqueueAdCandidate(candidate({
      text: "加V direct",
      sampleContext: { quote: "转发来的广告" },
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(disposeAdSender).not.toHaveBeenCalled();
    expect(warnReferencedAdSender).not.toHaveBeenCalled();
    expect(errorLogs.some((line: string): boolean =>
      line.includes("direct-content classifier returned no verdict")
    )).toBeTrue();
  });

  test("判定失败当作本次没判定，但不无限重试同一批", async () => {
    classifyAdText.mockImplementation(async (): Promise<AdVerdict | null> => null);
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);

    await runAdDetectBatch(1_000);
    expect(disposeAdSender).not.toHaveBeenCalled();
    // 失败也推进判定进度：DeepSeek 侧故障时重排就是每秒一批的请求风暴。
    expect(pendingAdMessages.get("-1001:7")?.checkedSeq).toBe(1);
    expect(adDetectQueue.size).toBe(0);
  });

  test("同一个人不会被并发送检两次", async () => {
    let release!: (verdict: AdVerdict) => void;
    classifyAdText.mockImplementationOnce((): Promise<AdVerdict> => new Promise<AdVerdict>((resolve) => {
      release = resolve;
    }));
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    const first: Promise<void> = runAdDetectBatch(1_000);

    enqueueAdCandidate(candidate({ messageId: 2 }), 1_100);
    expect(inFlightAdDetectKeys.has("-1001:7")).toBe(true);
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(false);
    // 在途期间新消息只并串，不排第二个位置，也不会再发一次请求。
    expect(adDetectQueue.size).toBe(0);
    await runAdDetectBatch(1_100);
    expect(classifyAdText).toHaveBeenCalledTimes(1);

    release({ isAd: false, reason: "" });
    await first;
    // 当前批只推进派发前冻结的水位；在途期间的新消息结算后恰好重排一次。
    expect(adDetectQueue.size).toBe(1);
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(true);
    await runAdDetectBatch(1_100);
    expect(classifyAdText).toHaveBeenCalledTimes(2);
  });

  test("停管/关开关丢掉该群待检串，在途判定结算后不再处置", async () => {
    let release!: (verdict: AdVerdict) => void;
    classifyAdText.mockImplementationOnce((): Promise<AdVerdict> => new Promise<AdVerdict>((resolve) => {
      release = resolve;
    }));
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    enqueueAdCandidate(candidate({ chatId: -1002, senderId: 9, messageId: 2 }), 1_000);
    const running: Promise<void> = runAdDetectBatch(1_000);

    clearChatAdDetect(-1001);
    expect(pendingAdMessages.has("-1001:7")).toBe(false);
    expect(pendingAdMessages.has("-1002:9")).toBe(true);

    release({ isAd: true, reason: "引流" });
    await running;
    // 整串已经不在了：旧引用对不上，判定结果直接作废，不在已停管的群里封人。
    expect(disposeAdSender).not.toHaveBeenCalled();
  });

  test("sweep 只回收窗口外已消费上下文，未消费条目继续保留", async () => {
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 2 }), 1_000);
    await runAdDetectBatch(1_000);
    const late: number = 1_000 + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1;
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 3 }), late);

    sweepAdDetect(late);
    expect(pendingAdMessages.has("-1001:7")).toBe(false);
    expect(pendingAdMessages.has("-1001:8")).toBe(true);
    expect(pendingAdMessages.get("-1001:8")?.entries.map((entry) => entry.messageId)).toEqual([3]);
  });

  test("容量满载拒绝新 key，不淘汰已接纳或正在送检的 key", async () => {
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    let release!: (verdict: AdVerdict) => void;
    classifyAdText.mockImplementationOnce((): Promise<AdVerdict> => new Promise<AdVerdict>((resolve) => {
      release = resolve;
    }));
    enqueueAdCandidate(candidate({ messageId: 1, text: "USDT 承兑加我" }), 1_000);
    const running: Promise<void> = runAdDetectBatch(1_000);
    expect(inFlightAdDetectKeys.has("-1001:7")).toBe(true);

    // 一波新发送者把表撑到上界：满载后拒绝后来者，不能挤掉已经接纳的广告号。
    for (let index: number = 0; index < AD_DETECT_MAX_PENDING_SENDERS + 5; index++) {
      enqueueAdCandidate(candidate({ senderId: 1_000 + index }), 1_000);
    }
    expect(pendingAdMessages.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(pendingAdMessages.has("-1001:7")).toBe(true);
    expect(adDetectQueue.size).toBe(AD_DETECT_MAX_PENDING_SENDERS - 1);
    expect(queuedAdDetectKeys.size).toBe(AD_DETECT_MAX_PENDING_SENDERS - 1);
    expect(pendingAdMessages.has(`-1001:${1_000 + AD_DETECT_MAX_PENDING_SENDERS + 4}`)).toBe(false);

    let payloadReads: number = 0;
    const unreadAtCapacity: AdCandidateMessage = candidate({
      senderId: 1_000 + AD_DETECT_MAX_PENDING_SENDERS + 10,
    });
    Object.defineProperties(unreadAtCapacity, {
      text: { get: (): string => { payloadReads++; throw new Error("text must stay unread"); } },
      linkUrls: { get: (): string[] => { payloadReads++; throw new Error("links must stay unread"); } },
      sampleContext: { get: (): never => { payloadReads++; throw new Error("context must stay unread"); } },
    });
    expect((): void => enqueueAdCandidate(unreadAtCapacity, 1_000)).not.toThrow();
    expect(payloadReads).toBe(0);

    release({ isAd: true, reason: "引流" });
    await running;
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
  });

  test("清群同时摘掉该群在 Map、队列、判定窗口与警告窗口里的键", () => {
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    enqueueAdCandidate(candidate({ chatId: -1002, senderId: 9, messageId: 2 }), 1_000);
    referencedAdWarningStates.set("-1001:7", {
      phase: "warned",
      generation: 1,
      warnedAt: 1_000,
      expiresAt: 10_000,
    });
    referencedAdWarningStates.set("-1002:9", {
      phase: "warned",
      generation: 2,
      warnedAt: 1_000,
      expiresAt: 10_000,
    });
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(true);

    clearChatAdDetect(-1001);
    // 留着只会让重新开启开关后的头一个窗口白白哑火。
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(false);
    expect(queuedAdDetectKeys.has("-1002:9")).toBe(true);
    expect(pendingAdMessages.has("-1001:7")).toBe(false);
    expect(pendingAdMessages.has("-1002:9")).toBe(true);
    expect(referencedAdWarningStates.has("-1001:7")).toBe(false);
    expect(referencedAdWarningStates.has("-1002:9")).toBe(true);
    expect([...queuedAdDetectKeys]).toEqual(["-1002:9"]);
    expect(adDetectQueue.size).toBe(1);
    expect(adDetectQueue.peek()).toBe("-1002:9");
  });

  test("停机 quiesce 只停节拍、不动状态，也不把在途判定挂进 drain 等待集合", async () => {
    // drain 的预算是秒级，一次判定却能耗到 20 秒：登记进在途集合的话，停机时
    // 恰好有判定在途就必然超时，换来脏退出加一批 update 重投。
    let release!: (verdict: AdVerdict) => void;
    classifyAdText.mockImplementationOnce((): Promise<AdVerdict> => new Promise<AdVerdict>((resolve) => {
      release = resolve;
    }));
    startAdDetectQueue((): void => {});
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    const running: Promise<void> = runAdDetectBatch(1_000);
    expect(antiRaidInFlightTasks.size).toBe(0);

    quiesceAdDetectQueue();
    expect(adDetectTickTimer.current).toBeNull();
    // 状态原样留着：它随 isolate 一起消失，退出路径上不必多做清理。
    expect(pendingAdMessages.size).toBe(1);

    release({ isAd: false, reason: "" });
    await running;
  });

  test("quiesce 之后才回来的判定一律不处置：那半边处置已经没人接了", async () => {
    let release!: (verdict: AdVerdict) => void;
    classifyAdText.mockImplementationOnce((): Promise<AdVerdict | null> =>
      new Promise<AdVerdict | null>((resolve: (verdict: AdVerdict | null) => void): void => {
        release = resolve;
      })
    );
    enqueueAdCandidate(candidate({ text: "加我微信" }), 1_000);
    const running: Promise<void> = runAdDetectBatch(1_000);

    // 停机：判定不在在途任务集合里，drainAntiRaid 那轮 drainAdDisposals 会直接
    // 放行，主线程的落盘线程随后 terminate。
    quiesceAdDetectQueue();
    release({ isAd: true, reason: "引流" });
    await running;

    // 照常处置的话，群里会收到「在所有盯着的群里一起封掉了」，而那条黑名单
    // 根本写不进 memory/blocklist/blocklist.json，重启后此人若无其事。
    expect(disposeAdSender).not.toHaveBeenCalled();
  });

  test("启动登记回投通道与唯一节拍，停止后全部清空", () => {
    const events: AdDetectedEvent[] = [];
    startAdDetectQueue((event: AdDetectedEvent): void => { events.push(event); });
    startAdDetectQueue((event: AdDetectedEvent): void => { events.push(event); });
    expect(adDetectPublishHolder.current).not.toBeNull();

    enqueueAdCandidate(candidate());
    inFlightReferencedAdCleanupTasks.add(Promise.resolve());
    referencedAdWarningStates.set("-1001:7", {
      phase: "warned",
      generation: 3,
      warnedAt: 1_000,
      expiresAt: 10_000,
    });
    stopAdDetectQueue();
    expect(adDetectPublishHolder.current).toBeNull();
    expect(pendingAdMessages.size).toBe(0);
    expect(queuedAdDetectKeys.size).toBe(0);
    expect(recentlyDisposedAdKeys.size).toBe(0);
    expect(referencedAdWarningStates.size).toBe(0);
    expect(inFlightReferencedAdCleanupTasks.size).toBe(0);
    expect(adDetectQueue.size).toBe(0);
  });

  test("离开队列的键无论走哪条出口都交还待检位置", async () => {
    // 位置一交出去就必须从 queuedAdDetectKeys 消失，否则「谁在待检」有两个
    // 互相矛盾的答案：键不在队列里却仍被判成已排队，未判内容再也排不回来。
    const key: string = "-1001:7";

    // 出口一：消息串已经不在了（清群之类）。
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    pendingAdMessages.delete(key);
    await runAdDetectBatch(1_000);
    expect(queuedAdDetectKeys.has(key)).toBe(false);
    expectQueueOwnershipConsistent();

    // 出口二：裁剪之后整串空了，pending 一并摘掉。
    resetAdDetectQueueHarness(stopAdDetectQueue);
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    pendingAdMessages.get(key)!.entries.length = 0;
    await runAdDetectBatch(1_000);
    expect(pendingAdMessages.has(key)).toBe(false);
    expect(queuedAdDetectKeys.has(key)).toBe(false);
    expectQueueOwnershipConsistent();

    // 出口三：上一次判定还没回来，这一拍不重复送检。
    resetAdDetectQueueHarness(stopAdDetectQueue);
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    inFlightAdDetectKeys.add(key);
    await runAdDetectBatch(1_000);
    expect(queuedAdDetectKeys.has(key)).toBe(false);
    expectQueueOwnershipConsistent();
    inFlightAdDetectKeys.delete(key);

    // 出口四：整串都判过，这一拍没有要送检的内容。
    resetAdDetectQueueHarness(stopAdDetectQueue);
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    pendingAdMessages.get(key)!.checkedSeq = 1;
    await runAdDetectBatch(1_000);
    expect(classifyAdText).not.toHaveBeenCalled();
    expect(queuedAdDetectKeys.has(key)).toBe(false);
    expectQueueOwnershipConsistent();
  });

  test("反复「入队 -> 空串 -> 出队」不会让待检位置数越过待检 key 数", async () => {
    // 这条不变量此前没有任何断言守着，正是同类失配让容量闸误报过满载。
    for (let round: number = 0; round < 32; round++) {
      const at: number = 1_000 + round;
      enqueueAdCandidate(candidate({ senderId: round, messageId: round + 1 }), at);
      pendingAdMessages.get(`-1001:${round}`)!.entries.length = 0;
      await runAdDetectBatch(at);
      expectQueueOwnershipConsistent();
    }
    expect(queuedAdDetectKeys.size).toBe(0);
    expect(pendingAdMessages.size).toBe(0);
  });

  test("墙钟回拨时处置抑制强制失效，不拉长成「回拨幅度 + 窗口」", () => {
    recentlyDisposedAdKeys.set("-1001:9", 10_000);

    // NTP 把钟往回拨。按失效时刻比较的话这条记录会多活「回拨幅度 + 90 秒」，
    // 期间这个人的消息一律 ignore，判定对他静默停摆。
    expireAdDetectDisposalMarkers(9_000);

    expect(recentlyDisposedAdKeys.has("-1001:9")).toBe(false);
  });

  test("回拨后处置抑制立即解除，同一个人的新消息照常收下", () => {
    recentlyDisposedAdKeys.set("-1001:7", 10_000);

    enqueueAdCandidate(candidate({ messageId: 1, text: "换个号继续" }), 9_000);

    expect(recentlyDisposedAdKeys.has("-1001:7")).toBe(false);
    expect(pendingAdMessages.has("-1001:7")).toBe(true);
  });

  test("sweep 补排失去调度位置的未判消息串，接手旧窗口轮换的自愈职责", () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "USDT 承兑加我" }), 1_000);
    // 模拟异常态：队列位置没了，消息串还留着未判内容。派发循环只走队列，
    // 这种串没有任何其它力量会把它排回去。
    adDetectQueue.clear();
    queuedAdDetectKeys.clear();
    expect(pendingAdMessages.get("-1001:7")!.entries.length).toBe(1);

    sweepAdDetect(1_500);

    expect(adDetectQueue.size).toBe(1);
    expect(queuedAdDetectKeys.has("-1001:7")).toBe(true);
    expectQueueOwnershipConsistent();
  });

  test("sweep 不给已经判完的串白排一次判定", () => {
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    pendingAdMessages.get("-1001:7")!.checkedSeq = 1;
    adDetectQueue.clear();
    queuedAdDetectKeys.clear();

    sweepAdDetect(1_500);

    expect(adDetectQueue.size).toBe(0);
    expect(queuedAdDetectKeys.size).toBe(0);
  });

  test("处置去重表撞顶时淘汰最早处置的键，不无限增长", async () => {
    // 这张表只由处置路径写入，没有任何入口闸替它把关；节拍停掉或处置快过回收
    // 时它是整条流水线里唯一一张会无限长的表。
    const disposedAt: number = Date.now();
    for (let index: number = 0; index < AD_DETECT_MAX_PENDING_SENDERS; index++) {
      recentlyDisposedAdKeys.set(`-1002:${index}`, disposedAt);
    }
    expect(recentlyDisposedAdKeys.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);

    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    enqueueAdCandidate(candidate({ messageId: 1, text: "USDT 承兑加我" }), disposedAt);
    await runAdDetectBatch(disposedAt);

    expect(recentlyDisposedAdKeys.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(recentlyDisposedAdKeys.has("-1001:7")).toBe(true);
    // FIFO：挤掉的是最早写进去的那个，它的封禁早已落地。
    expect(recentlyDisposedAdKeys.has("-1002:0")).toBe(false);
    expect(recentlyDisposedAdKeys.has("-1002:1")).toBe(true);
  });

  test("在途闸长期撑满：积压的键坐满一个窗口也不丢位置、不产生副本", async () => {
    // 已接纳的键撞上在途上限时留在队列里等容量恢复，不会过期（见
    // docs/cn/04-invariants.md）。撑满在途闸把这段积压真造出来。
    classifyAdText.mockImplementation((): Promise<AdVerdict> => new Promise<AdVerdict>((): void => {}));
    const startedAt: number = 1_000;
    const senders: number = AD_DETECT_MAX_IN_FLIGHT + AD_DETECT_BATCH_SIZE;
    for (let index: number = 0; index < senders; index++) {
      enqueueAdCandidate(candidate({ senderId: index, messageId: index + 1 }), startedAt);
    }
    expect(adDetectQueue.size).toBe(senders);
    expectQueueOwnershipConsistent();

    // 每拍最多起 AD_DETECT_BATCH_SIZE 个，撞上 AD_DETECT_MAX_IN_FLIGHT 后停手。
    while (inFlightAdDetectKeys.size < AD_DETECT_MAX_IN_FLIGHT) {
      void runAdDetectBatch(startedAt);
      expectQueueOwnershipConsistent();
    }
    expect(inFlightAdDetectKeys.size).toBe(AD_DETECT_MAX_IN_FLIGHT);
    const backlog: number = adDetectQueue.size;
    expect(backlog).toBe(AD_DETECT_BATCH_SIZE);

    // 积压的那批在队列里坐满一个窗口，队列位置必须原样保留。
    const afterWindow: number = startedAt + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1;
    void runAdDetectBatch(afterWindow);
    sweepAdDetect(afterWindow);

    expect(adDetectQueue.size).toBe(backlog);
    expect(queuedAdDetectKeys.size).toBe(backlog);
    expectQueueOwnershipConsistent();
  });

  test("长期积压期间同一个人的新消息只并串，不排出第二个位置", async () => {
    // 挡住重复入队的只有 queuedAdDetectKeys 一道。它要是不管用，同一个人会在
    // 队列里占两个位置，判定额度被一个人吃掉两份。
    classifyAdText.mockImplementation((): Promise<AdVerdict> => new Promise<AdVerdict>((): void => {}));
    const startedAt: number = 1_000;
    for (let index: number = 0; index < AD_DETECT_MAX_IN_FLIGHT + 1; index++) {
      enqueueAdCandidate(candidate({ senderId: index, messageId: index + 1 }), startedAt);
    }
    while (inFlightAdDetectKeys.size < AD_DETECT_MAX_IN_FLIGHT) {
      void runAdDetectBatch(startedAt);
    }
    const backlogKey: string = `-1001:${AD_DETECT_MAX_IN_FLIGHT}`;
    expect(queuedAdDetectKeys.has(backlogKey)).toBe(true);

    const afterWindow: number = startedAt + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1;
    sweepAdDetect(afterWindow);
    expect(queuedAdDetectKeys.has(backlogKey)).toBe(true);

    const queuedBefore: number = adDetectQueue.size;
    enqueueAdCandidate(candidate({
      senderId: AD_DETECT_MAX_IN_FLIGHT,
      messageId: 9_999,
      text: "再来一条",
    }), afterWindow);

    expect(adDetectQueue.size).toBe(queuedBefore);
    expect(pendingAdMessages.get(backlogKey)!.entries).toHaveLength(2);
    expectQueueOwnershipConsistent();
  });

  test("正常调度的每一步都维持「队列与待检位置表一致」", async () => {
    // 覆盖派发、结算补排、判成广告摘串三条主路径，而不只是异常出口。
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    expectQueueOwnershipConsistent();
    await runAdDetectBatch(1_000);
    expectQueueOwnershipConsistent();

    enqueueAdCandidate(candidate({ messageId: 2, text: "换汇加我" }), 1_100);
    expectQueueOwnershipConsistent();
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    await runAdDetectBatch(1_100);
    expectQueueOwnershipConsistent();
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    sweepAdDetect(1_200);
    expectQueueOwnershipConsistent();
  });
});
