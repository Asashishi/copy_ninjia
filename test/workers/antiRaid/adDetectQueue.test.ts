import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdCandidateMessage, AdDetectedEvent } from "../../../packages/types/antiRaid";
import type { AdVerdict } from "../../../packages/types/antiRaid/adDetect";

const classifyAdText = mock(async (_text: string): Promise<AdVerdict | null> => ({ isAd: false, reason: "" }));
const disposeAdSender = mock(async (..._args: unknown[]): Promise<void> => {});
const deleteStragglerAdMessage = mock((_chatId: number, _messageId: number): void => {});
const classifiedTexts: string[] = [];
const classifiedFacts: boolean[] = [];
/** 各群的管理员集合；undefined 表示缓存未命中，freshAdminIds 据此返回 undefined。 */
const cachedAdmins = new Map<number, Set<number>>();
const fetchedAdmins = new Map<number, Set<number>>();
const fetchAdminIds = mock(async (chatId: number): Promise<Set<number>> => {
  const admins: Set<number> | undefined = fetchedAdmins.get(chatId);
  if (!admins) throw new Error("admin fetch failed");
  return admins;
});

const errorLogs: string[] = [];
mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../../packages/workers/antiRaid/adDetect/classifier", () => ({
  classifyAdText: async (params: { text: string; justJoined: boolean }): Promise<AdVerdict | null> => {
    classifiedTexts.push(params.text);
    classifiedFacts.push(params.justJoined);
    return classifyAdText(params.text);
  },
}));
mock.module("../../../packages/workers/antiRaid/adDetect/disposal", () => ({
  disposeAdSender,
  deleteStragglerAdMessage,
}));
mock.module("../../../packages/workers/antiRaid/adminCache", () => ({
  freshAdminIds: (chatId: number): Set<number> | undefined => cachedAdmins.get(chatId),
  fetchAdminIds,
}));

const {
  clearChatAdDetect,
  enqueueAdCandidate,
  quiesceAdDetectQueue,
  rotateAdDetectDedupWindow,
  runAdDetectBatch,
  startAdDetectQueue,
  stopAdDetectQueue,
  sweepAdDetect,
} = await import("../../../packages/workers/antiRaid/adDetect/queue");
// 消息串的整形（裁剪/收容量/拼正文）拆在 bundle.ts，见该文件头注。
const { formatAdBundleText } = await import("../../../packages/workers/antiRaid/adDetect/bundle");
const { antiRaidInFlightTasks } = await import("../../../packages/cache/workers/antiRaid/tasks");
const {
  adDetectDedupTimer,
  adDetectQueue,
  adDetectPublishHolder,
  adDetectTickTimer,
  inFlightAdDetectKeys,
  pendingAdMessages,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
  recentlyEnqueuedAdKeys,
} = await import("../../../packages/cache/workers/antiRaid/adDetect");
const {
  AD_DETECT_BATCH_SIZE,
  AD_DETECT_BUNDLE_MAX_CHARS,
  AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS,
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_LINK_URLS,
  AD_DETECT_MAX_MESSAGES_PER_SENDER,
  AD_DETECT_MAX_PENDING_SENDERS,
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} = await import("../../../packages/consts/antiRaid/adDetect");

function candidate(overrides: Partial<AdCandidateMessage> = {}): AdCandidateMessage {
  return {
    type: "adCandidate",
    chatId: -1001,
    senderId: 7,
    messageId: 1,
    text: "随便聊聊",
    linkUrls: [],
    label: "@spammer",
    isChannel: false,
    blocked: false,
    justJoined: false,
    ...overrides,
  };
}

beforeEach(() => {
  stopAdDetectQueue();
  errorLogs.length = 0;
  classifiedTexts.length = 0;
  classifiedFacts.length = 0;
  classifyAdText.mockClear();
  classifyAdText.mockImplementation(async (): Promise<AdVerdict | null> => ({ isAd: false, reason: "" }));
  disposeAdSender.mockClear();
  deleteStragglerAdMessage.mockClear();
  fetchAdminIds.mockClear();
  cachedAdmins.clear();
  fetchedAdmins.clear();
  // 默认：管理员表拿得到且目标不是管理员，处置照常走。
  fetchedAdmins.set(-1001, new Set());
});

describe("广告判定队列", () => {
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

  test("去重窗口外已消费的旧上下文会裁掉，新消息仍算未判定", () => {
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    const bundle = pendingAdMessages.get("-1001:7")!;
    bundle.checkedSeq = 1;

    enqueueAdCandidate(candidate({ messageId: 2 }), 1_000 + AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS + 1);
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

    const late: number = 1_100 + AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS + 1;
    enqueueAdCandidate(candidate({ messageId: 3, text: "加我微信" }), late);
    enqueueAdCandidate(candidate({ messageId: 4, text: "带你上岸" }), late);
    const bundle = pendingAdMessages.get("-1001:7")!;
    expect(bundle.entries.map((entry) => entry.messageId)).toEqual([1, 2, 3, 4]);

    release({ isAd: false, reason: "" });
    await running;
    expect(bundle.checkedSeq).toBe(2);

    rotateAdDetectDedupWindow();
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

    for (let index: number = 0; index < AD_DETECT_MAX_PENDING_SENDERS + 5; index++) {
      enqueueAdCandidate(candidate({ senderId: 1_000 + index }));
    }
    expect(pendingAdMessages.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(adDetectQueue.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(queuedAdDetectKeys.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(recentlyEnqueuedAdKeys.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(pendingAdMessages.has(`-1001:${1_000 + AD_DETECT_MAX_PENDING_SENDERS + 4}`)).toBe(false);
  });

  test("已接纳 key 等待超过去重窗口仍会获得首次判定", async () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "排队中的广告" }), 1_000);

    await runAdDetectBatch(1_000 + AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS + 1);

    expect(classifiedTexts).toEqual(["1. 排队中的广告"]);
    expect(pendingAdMessages.get("-1001:7")?.checkedSeq).toBe(1);
  });

  test("判定抛错按「本次没判定」结算：记一行日志、推进水位，不静默死循环", async () => {
    // classifyAdText 的同步准备阶段也会抛：它先调 adDetectSystemPrompt →
    // getAdSampleConfig()，而后者只缓存成功结果——进程启动之后把
    // config/ad_samples.json 改坏，每一次调用都重新抛同一个错。不接住的话异常
    // 一路逃到 runAdDetectBatch 的 Promise.allSettled 被整个吞掉：checkedSeq
    // 永不推进，这个键每轮去重窗口轮换都重判、每次都失败，全程一行日志都没有，
    // 而 /ad_detect 仍然报告功能已启用。
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

  test("一个窗口内同一个人只判一次，期间新说的话只并进消息串", async () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "在吗" }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifiedTexts).toEqual(["1. 在吗"]);
    expect(adDetectQueue.size).toBe(0);
    expect(pendingAdMessages.get("-1001:7")?.checkedSeq).toBe(1);

    // 同一串没有新内容时不该被重复判定，否则每一拍都在重烧同一条消息。
    await runAdDetectBatch(1_000);
    expect(classifyAdText).toHaveBeenCalledTimes(1);

    // 窗口内的后续消息不再各自触发一次判定：只并串，等窗口轮换时一起判。
    enqueueAdCandidate(candidate({ messageId: 2, text: "加我微信" }), 2_000);
    enqueueAdCandidate(candidate({ messageId: 3, text: "带你上岸" }), 3_000);
    expect(adDetectQueue.size).toBe(0);
    await runAdDetectBatch(3_000);
    expect(classifyAdText).toHaveBeenCalledTimes(1);
    expect(pendingAdMessages.get("-1001:7")?.entries).toHaveLength(3);
  });

  test("窗口轮换时把攒着未判定内容的键补排一次，并带上整串上下文", async () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "在吗" }), 1_000);
    await runAdDetectBatch(1_000);
    enqueueAdCandidate(candidate({ messageId: 2, text: "加我微信" }), 2_000);
    enqueueAdCandidate(candidate({ messageId: 3, text: "带你上岸" }), 3_000);

    rotateAdDetectDedupWindow();
    expect(recentlyEnqueuedAdKeys.has("-1001:7")).toBe(true);
    expect(adDetectQueue.size).toBe(1);
    await runAdDetectBatch(3_000);
    // 补排这一步不能省：窗口内第二条之后的消息没有自己的入队机会，只清表不
    // 补排的话，拆开发的广告会永远停在第一条的无害判定上。
    expect(classifiedTexts[1]).toBe("1. 在吗\n2. 加我微信\n3. 带你上岸");
  });

  test("窗口轮换不会给没有新内容的键白排一次判定", async () => {
    enqueueAdCandidate(candidate({ messageId: 1, text: "在吗" }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifyAdText).toHaveBeenCalledTimes(1);

    rotateAdDetectDedupWindow();
    expect(adDetectQueue.size).toBe(0);
    await runAdDetectBatch(1_000);
    expect(classifyAdText).toHaveBeenCalledTimes(1);
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
    // 在途期间新消息只并串，不排第二个位置，也不会再发一次请求。
    expect(adDetectQueue.size).toBe(0);
    await runAdDetectBatch(1_100);
    expect(classifyAdText).toHaveBeenCalledTimes(1);

    release({ isAd: false, reason: "" });
    await first;
    // 本窗口他已经判过一次，结算时不再补排；新消息留在串里等窗口轮换。
    expect(adDetectQueue.size).toBe(0);
    rotateAdDetectDedupWindow();
    expect(adDetectQueue.size).toBe(1);
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
    const late: number = 1_000 + AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS + 1;
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 3 }), late);

    sweepAdDetect(late);
    expect(pendingAdMessages.has("-1001:7")).toBe(false);
    expect(pendingAdMessages.has("-1001:8")).toBe(true);
    expect(pendingAdMessages.get("-1001:8")?.entries.map((entry) => entry.messageId)).toEqual([3]);
  });

  test("拼串只负责编号，取舍由 selectAdBundleEntries 定完再交过来", () => {
    expect(formatAdBundleText([
      { messageId: 1, seq: 1, text: "第一条", receivedAt: 1 },
      { messageId: 2, seq: 2, text: "第二条", receivedAt: 2 },
    ])).toBe("1. 第一条\n2. 第二条");
    expect(formatAdBundleText([])).toBe("");
  });

  test("送检预算装不下时按序判定，没送审的条目不算判过", async () => {
    // 一条广告后面跟一串灌水撑爆 AD_DETECT_BUNDLE_MAX_CHARS。水位只能推到这一拍
    // 真正送检的最后一条：从最新一条往回取的话，最旧的那条广告会夹在水位下面被
    // 记成判过再被 pruneConsumedContext 裁掉——模型从没读过它，也就永远判不出来。
    const filler: string = "填".repeat(AD_DETECT_MESSAGE_MAX_CHARS);
    const fillerCount: number = Math.ceil(AD_DETECT_BUNDLE_MAX_CHARS / AD_DETECT_MESSAGE_MAX_CHARS) + 1;
    enqueueAdCandidate(candidate({ messageId: 1, text: "日入过千 加V xxx996" }), 1_000);
    for (let index: number = 0; index < fillerCount; index++) {
      enqueueAdCandidate(candidate({ messageId: index + 2, text: filler }), 1_000 + index);
    }

    await runAdDetectBatch(1_000);
    const bundle = pendingAdMessages.get("-1001:7")!;
    // 第一拍读到的是最旧那批（广告在其中），而不是被预算挤剩的尾巴。
    expect(classifiedTexts[0]).toContain("日入过千");
    expect(bundle.checkedSeq).toBeLessThan(fillerCount + 1);
    expect(bundle.entries.some((entry) => entry.seq > bundle.checkedSeq)).toBe(true);

    // 剩下的未判条目在去重窗口轮换后照样判得到，一条都不落。
    rotateAdDetectDedupWindow();
    await runAdDetectBatch(1_000 + AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS + 1);
    expect(bundle.checkedSeq).toBe(fillerCount + 1);
  });

  test("引用与回复接进送检文本一起判定：广告主流形态是「编辑旧消息 + 回复/引用顶上来」，" +
    "广告正文永远不在新消息的 text 里", async () => {
    // quote 与 replyTo 完全重合（引用的正是所回复消息的片段）时只接一遍，
    // 重复接只是白烧送检预算。
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "这种广告真烦",
      sampleContext: { quote: "日入过千 加V xxx996", replyTo: "日入过千 加V xxx996" },
    }), 1_000);

    const entry = pendingAdMessages.get("-1001:7")!.entries[0]!;
    expect(entry.text).toBe("这种广告真烦 日入过千 加V xxx996");
    // 样本侧仍留一份没并进正文的原样：人回头查误判时要分得清哪段是他自己写的。
    expect(entry.quote).toBe("日入过千 加V xxx996");
    expect(entry.replyTo).toBe("日入过千 加V xxx996");

    await runAdDetectBatch(1_000);
    expect(classifiedTexts).toEqual(["1. 这种广告真烦 日入过千 加V xxx996"]);
  });

  test("同一段引文整串只接一份：拆开发的碎片才凑得进同一份清单，不被重复引文吃掉预算", async () => {
    // 广告号把话术拆成三条、每条都回复同一条（已被编辑成广告的）消息。
    const replyTo: string = "日".repeat(AD_SAMPLE_CONTEXT_MAX_CHARS);
    for (const [index, own] of ["加我", "微 信", "xxx996"].entries()) {
      enqueueAdCandidate(candidate({ messageId: index + 1, text: own, sampleContext: { replyTo } }), 1_000);
    }

    const entries = pendingAdMessages.get("-1001:7")!.entries;
    expect(entries.map((entry): string => entry.text)).toEqual([`加我 ${replyTo}`, "微 信", "xxx996"]);
    // 样本侧照旧每条都留一份原样：判定去重了，取证不能跟着丢。
    expect(entries.map((entry): string | undefined => entry.replyTo)).toEqual([replyTo, replyTo, replyTo]);

    await runAdDetectBatch(1_000);
    // 三个碎片与那段引文一起进同一次判定，而不是被切成好几轮各判一个无害片段。
    expect(classifiedTexts).toEqual([`1. 加我 ${replyTo}\n2. 微 信\n3. xxx996`]);
  });

  test("认领者被裁掉后引文重新认领：串里再没人带着它时，下一条候选自己接一份", async () => {
    const replyTo: string = "日入过千 加V xxx996";
    enqueueAdCandidate(candidate({ messageId: 1, text: "看这个", sampleContext: { replyTo } }), 1_000);
    await runAdDetectBatch(1_000);

    // 第一条判过又出了去重窗口，pruneConsumedContext 会把它连引文一起裁掉。
    const later: number = 1_000 + AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS + 1;
    enqueueAdCandidate(candidate({ messageId: 2, text: "再看这个", sampleContext: { replyTo } }), later);

    const entries = pendingAdMessages.get("-1001:7")!.entries;
    expect(entries.map((entry): string => entry.text)).toEqual([`再看这个 ${replyTo}`]);
  });

  test("引用段与被回复原文不同时两段都接，且不带「引用：」这类可被伪造的系统措辞", async () => {
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "真的假的",
      sampleContext: { quote: "日入过千", replyTo: "加V xxx996" },
    }), 1_000);

    await runAdDetectBatch(1_000);
    expect(classifiedTexts).toEqual(["1. 真的假的 日入过千 加V xxx996"]);
  });

  test("上下文接在正文截断之后，几百字废话顶不掉引文", async () => {
    // 先拼后截就是一条零成本绕过：填充文本把引文挤出 AD_DETECT_MESSAGE_MAX_CHARS。
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "废".repeat(AD_DETECT_MESSAGE_MAX_CHARS + 200),
      sampleContext: { quote: "日入过千 加V xxx996" },
    }), 1_000);

    const entry = pendingAdMessages.get("-1001:7")!.entries[0]!;
    expect(entry.text).toBe(`${"废".repeat(AD_DETECT_MESSAGE_MAX_CHARS)} 日入过千 加V xxx996`);
  });

  test("落地页 URL 有独立配额，填充文本顶不掉它", () => {
    // 正文按 AD_DETECT_MESSAGE_MAX_CHARS 从头保留，URL 接在截断之后——共用额度
    // 的话，七百字废话加一个「点这里」超链接就能让落地页永远到不了模型面前。
    enqueueAdCandidate(candidate({
      text: "填".repeat(AD_DETECT_MESSAGE_MAX_CHARS + 200),
      linkUrls: ["https://t.me/spamchannel"],
    }), 1_000);
    const text: string = pendingAdMessages.get("-1001:7")!.entries[0]!.text;
    expect(text.endsWith(" https://t.me/spamchannel")).toBe(true);
    expect(text).toHaveLength(AD_DETECT_MESSAGE_MAX_CHARS + 1 + "https://t.me/spamchannel".length);
  });

  test("URL 段自己也有上界：条数与单条长度在 Worker 侧再收一次", () => {
    enqueueAdCandidate(candidate({
      text: "点这里",
      linkUrls: [
        ...Array.from({ length: AD_DETECT_MAX_LINK_URLS + 3 }, (_unused, index: number) => `https://spam.example/${index}`),
        `https://spam.example/${"x".repeat(AD_DETECT_LINK_URL_MAX_CHARS)}`,
      ],
    }), 1_000);
    const parts: string[] = pendingAdMessages.get("-1001:7")!.entries[0]!.text.split(" ");
    expect(parts).toHaveLength(AD_DETECT_MAX_LINK_URLS + 1);
    for (const part of parts.slice(1)) expect(part.length).toBeLessThanOrEqual(AD_DETECT_LINK_URL_MAX_CHARS);
  });

  test("命中后同窗口内抢跑进来的消息直接丢弃，不再攒出第二次处置", async () => {
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    enqueueAdCandidate(candidate({ messageId: 1, text: "USDT 承兑加我" }), 1_000);
    await runAdDetectBatch(1_000);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    expect(recentlyDisposedAdKeys.has("-1001:7")).toBe(true);

    // 封禁还没落地时他还能再说几句；重判只会换来第二次完全相同的处置。
    enqueueAdCandidate(candidate({ messageId: 2, text: "还有名额" }), 1_500);
    expect(pendingAdMessages.size).toBe(0);
    await runAdDetectBatch(1_500);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    // 窗口轮换后抑制解除；此时主线程的黑名单门禁早已接管投递侧。
    rotateAdDetectDedupWindow();
    expect(recentlyDisposedAdKeys.size).toBe(0);
  });

  test("命中后频道马甲抢跑进来的广告照样删掉", async () => {
    // banChatSenderChat 没有 revoke_messages，逐条删除是这些消息唯一的清理路径；
    // 判定到封禁落地之间还隔着回投主线程、名单 fsync 与 outbox 屏障。
    classifyAdText.mockImplementation(async (): Promise<AdVerdict> => ({ isAd: true, reason: "引流" }));
    enqueueAdCandidate(candidate({ senderId: -1005, isChannel: true, messageId: 1, text: "USDT 承兑" }), 1_000);
    await runAdDetectBatch(1_000);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    enqueueAdCandidate(candidate({ senderId: -1005, isChannel: true, messageId: 2, text: "还有名额" }), 1_500);
    expect(deleteStragglerAdMessage).toHaveBeenCalledWith(-1001, 2);
    // 仍然不重判、不重新处置：那一套只该走一次。
    expect(pendingAdMessages.size).toBe(0);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    // 真人目标走 revoke_messages，不需要这条补删。
    enqueueAdCandidate(candidate({ messageId: 3, text: "加我微信" }), 1_500);
    await runAdDetectBatch(1_500);
    expect(deleteStragglerAdMessage).toHaveBeenCalledTimes(1);
  });

  test("已拉黑的频道马甲跨窗口照样删，不占判定额度", () => {
    // recentlyDisposedAdKeys 只活一个去重窗口，而「已拉黑但封禁没落地」可以跨
    // 窗口存在（秒踢、补扫、上个窗口判定登记的封禁批次都是先写名单再等 outbox
    // 落盘与 mailbox 屏障）。窗口一轮换就只剩 blocked 这一个判据认得它。
    rotateAdDetectDedupWindow();
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
    expect(recentlyEnqueuedAdKeys.size).toBe(AD_DETECT_MAX_PENDING_SENDERS);
    expect(adDetectQueue.size).toBe(AD_DETECT_MAX_PENDING_SENDERS - 1);
    expect(queuedAdDetectKeys.size).toBe(AD_DETECT_MAX_PENDING_SENDERS - 1);
    expect(pendingAdMessages.has(`-1001:${1_000 + AD_DETECT_MAX_PENDING_SENDERS + 4}`)).toBe(false);

    release({ isAd: true, reason: "引流" });
    await running;
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
  });

  test("清群同时摘掉该群在 Map、队列与两张窗口表里的键", () => {
    enqueueAdCandidate(candidate({ messageId: 1 }), 1_000);
    enqueueAdCandidate(candidate({ chatId: -1002, senderId: 9, messageId: 2 }), 1_000);
    expect(recentlyEnqueuedAdKeys.has("-1001:7")).toBe(true);

    clearChatAdDetect(-1001);
    // 留着只会让重新开启开关后的头一个窗口白白哑火。
    expect(recentlyEnqueuedAdKeys.has("-1001:7")).toBe(false);
    expect(recentlyEnqueuedAdKeys.has("-1002:9")).toBe(true);
    expect(pendingAdMessages.has("-1001:7")).toBe(false);
    expect(pendingAdMessages.has("-1002:9")).toBe(true);
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
    expect(adDetectDedupTimer.current).toBeNull();
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
    stopAdDetectQueue();
    expect(adDetectPublishHolder.current).toBeNull();
    expect(pendingAdMessages.size).toBe(0);
    expect(queuedAdDetectKeys.size).toBe(0);
    expect(recentlyEnqueuedAdKeys.size).toBe(0);
    expect(recentlyDisposedAdKeys.size).toBe(0);
    expect(adDetectQueue.size).toBe(0);
  });
});
