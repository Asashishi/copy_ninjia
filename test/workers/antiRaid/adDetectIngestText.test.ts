import { beforeEach, describe, expect, test } from "bun:test";
import {
  candidate,
  classifiedTexts,
  errorLogs,
  resetAdDetectQueueHarness,
} from "../../helpers/adDetectQueueHarness";

const {
  enqueueAdCandidate,
  runAdDetectBatch,
  stopAdDetectQueue,
} = await import("../../../packages/workers/antiRaid/adDetect/queue");
const { formatAdBundleText } = await import("../../../packages/workers/antiRaid/adDetect/bundle");
const {
  adDetectQueue,
  pendingAdMessages,
} = await import("../../../packages/cache/workers/antiRaid/adDetect");
const {
  AD_DETECT_BUNDLE_MAX_CHARS,
  AD_DETECT_JUDGED_RETENTION_WINDOW_MS,
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_DETECT_MAX_MESSAGES_PER_SENDER,
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} = await import("../../../packages/consts/antiRaid/adDetect");

beforeEach((): void => resetAdDetectQueueHarness(stopAdDetectQueue));

describe("入队时的送检文本整形", () => {
  test("拼串只负责编号，取舍由 selectAdBundleEntries 定完再交过来", () => {
    expect(formatAdBundleText([
      {
        messageId: 1,
        seq: 1,
        text: "第一条",
        directText: "第一条",
        receivedAt: 1,
        withinReferencedWarning: false,
      },
      {
        messageId: 2,
        seq: 2,
        text: "第二条",
        directText: "第二条",
        receivedAt: 2,
        withinReferencedWarning: false,
      },
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

    // 剩下的未判条目在本批结算时已经重排，一条都不落。
    expect(adDetectQueue.size).toBe(1);
    await runAdDetectBatch(1_000 + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1);
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
    expect(entry.directText).toBe("这种广告真烦");
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
    const later: number = 1_000 + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1;
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

  test("单 key 条数上限挤掉从没判过的正文时记一行日志，每个发送者只记一次", () => {
    for (let index: number = 0; index < AD_DETECT_MAX_MESSAGES_PER_SENDER + 3; index++) {
      enqueueAdCandidate(candidate({ messageId: index + 1, text: `广告 ${index}` }), 1_000);
    }

    const dropped: string[] = errorLogs.filter((line: string): boolean =>
      line.includes("dropped never-judged message text")
    );
    // 丢的正文再也进不了分类器，这是本模块唯一一处「内容级」漏判，必须留痕；
    // 但撑满之后每条新消息都会再挤掉一条，逐条记就是往 logs/ 里刷屏。
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("sender 7");
    expect(pendingAdMessages.get("-1001:7")!.pendingDeleteIds).toHaveLength(3);
  });
});
