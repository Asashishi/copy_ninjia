import type { Message } from "@grammyjs/types";
import {
  senderUsernameCache,
  userCache,
} from "../../../packages/cache/main/senderIdentity";
import { sentMessages } from "../../../packages/cache/perThread/selfSentTracker";
import {
  clearAiReplyActivity,
  observeGroupMessageForAiReply,
} from "../../../packages/auto/message/aiReplyActivity";
import { isSelfSent } from "../../../packages/infra/selfSentTracker";
import { BoundedDeque } from "../../../packages/libs/boundedDeque";
import { LinkedQueue } from "../../../packages/libs/linkedQueue";
import { trimSlidingWindow } from "../../../packages/libs/slidingWindowRateLimit";
import { cacheSender } from "../../../packages/users/senderIdentity";
import {
  appendLinkUrls,
  boundSampleContext,
  claimSampleContextParts,
} from "../../../packages/workers/antiRaid/adDetect/bundle";
import { handleIncomingMessage } from "../../../packages/auto/message";
import { resolveMentionFacts, resolveReplyReference } from "../../../packages/auto/message/facts";
import { redactSecretsInText } from "../../../packages/libs/redaction";
import { LUCK_TIERS } from "../../../packages/consts/luckChallenge";
import { buildTieredVerbatimTranscript } from "../../../packages/aiChat/ai/utils/chatTranscript";
import { buildBufferedMessage } from "../../../packages/workers/aiChat/bufferedMessage";
import type { BufferedMessage } from "../../../packages/types/aiChat/memory";
import type { AiRecordContext } from "../../../packages/types/aiChat/protocol";
import type { MentionFacts } from "../../../packages/types/auto";
import type { Context } from "grammy";
import type { AdCandidateMessage, AdSampleContext } from "../../../packages/types/antiRaid";
import type { AdCandidateEntry } from "../../../packages/types/antiRaid/adDetect";
import { prototypeProbes } from "./jitTiers";
import type { JitProbe, Scenario, ScenarioName } from "./types";
import {
  ArrayTimestampWindow,
  Float64TimestampWindow,
  type RollingBuffer,
  type TimestampWindow,
} from "./containers";

/** 基准群聊 id；仅用于进程内 Map，不产生任何 Telegram 或磁盘副作用。 */
const BENCHMARK_CHAT_ID: number = -100_000_000_000_001;
/**
 * 所有时间戳场景的起点，取 2026-01-01T00:00:00Z 的毫秒值。
 *
 * 必须用生产量级，不能用 1_000_000 这类小整数。`Date.now()` 的毫秒值约 1.75e12，
 * 早已超出 int32；生产里这些窗口喂进来的全是 `Date.now()`，基准喂小整数就等于
 * 在量一份生产永远遇不到的输入。换成本常量后多个场景的读数明显移位
 * （linked-timestamp-window 46.8 → 74.1、linked-rolling-buffer 75.2 → 107.9
 * ns/op），说明旧读数确实建立在不具代表性的输入上。
 *
 * 需要澄清一点，免得后来者据此得出过强的结论：**单纯的大数值本身并不会让
 * JSC 反复去优化**——全程只喂 `Date.now()` 量级时，`observeGroupMessageForAiReply`
 * 稳定是 dfg=1/reopt=0。真正触发去优化的是**同一进程内先喂小整数、后喂大浮点**
 * 那次量级切换（实测 reopt 从 0 涨到 2）。对生产的启示不是「别用大时间戳」，而是
 * 同一个热函数不要在不同调用点喂进量级/类型不同的数值。
 *
 * 用固定常量而不是 `Date.now()`，是为了让各次运行的输入完全可复现。
 */
const BENCHMARK_EPOCH_MS: number = 1_767_225_600_000;
/** 广告无元数据路径的只读空输入，避免基准自身制造额外容器。 */
const EMPTY_LINK_URLS: readonly string[] = [];
/** 广告无上下文路径的只读既有条目。 */
const EMPTY_AD_ENTRIES: readonly AdCandidateEntry[] = [];
/**
 * 送检正文样本，逐轮轮换。
 *
 * 必须换着喂：在「无元数据」这条路上两个被测函数都是立刻返回——
 * `appendLinkUrls` 遇空 URL 表原样返回入参，`boundSampleContext` 遇 undefined
 * 直接返回 undefined——若整个循环体喂的是同一个字面量，循环体就是个常量表达式，
 * JSC 会把它整体提到循环外。实测这会让读数按进程在 ~0.6 ns/op（折叠掉了）和
 * ~11.5 ns/op（没折叠）之间二值跳变，前者量到的根本不是这条路径的成本。
 * 长度也要不同，让 `text.length` 真的随轮次变化。
 *
 * **换输入之后仍有残余二值性**（实测 ~5.8 与 ~14.2 ns/op 两簇），这是这条路径
 * 的固有性质，不是还没修干净：两个函数在此都退化成恒等/立即返回，内联之后本来
 * 就没有多少可测的东西，JSC 折不折叠就决定了读数落在哪一簇。因此本场景应当读作
 * 「这条早退路径有没有变重」的哨兵，而不是一个可跨进程直接比大小的绝对成本；
 * 真要收紧，得换成能产生真实工作量的输入，那已经是另一个场景了。
 *
 * 这张表最早是全仓第一处刻意不 `Object.freeze` 的只读常量——冻结后每轮凭空多
 * 30 ns 的脚手架成本，被测函数直接被淹没（实测同样的取值循环 frozen 35.7~46.2、
 * plain 6.5 ns/op）。后来这条结论推广成了全仓约定，见 AGENTS.md 的「常量」一节。
 */
const AD_SAMPLE_TEXTS: readonly string[] = [
  "ordinary message",
  "another ordinary message",
  "hi",
  "just a normal chat line here",
  "ok",
  "some slightly longer ordinary message body",
  "yet another one",
  "short",
];

/**
 * 两种时间窗实现的探针表，热/冷两组分开登记。
 *
 * 冷场景只 push、从不 trim（见 coldTimestampWindowScenario），把 trim 也登记
 * 进去只会得到一行恒为 0 的读数——探针表必须与该场景真实调用到的函数一致，
 * 否则 dfgCompiles=0 到底是「没热起来」还是「压根没调用」就分不清了。
 */
const ARRAY_WINDOW_PROBES: Readonly<Record<string, JitProbe>> =
  prototypeProbes("ArrayTimestampWindow", ArrayTimestampWindow.prototype, ["push", "trim"]);
const FLOAT64_WINDOW_PROBES: Readonly<Record<string, JitProbe>> =
  prototypeProbes("Float64TimestampWindow", Float64TimestampWindow.prototype, ["push", "trim"]);
const ARRAY_WINDOW_COLD_PROBES: Readonly<Record<string, JitProbe>> =
  prototypeProbes("ArrayTimestampWindow", ArrayTimestampWindow.prototype, ["push"]);
const FLOAT64_WINDOW_COLD_PROBES: Readonly<Record<string, JitProbe>> =
  prototypeProbes("Float64TimestampWindow", Float64TimestampWindow.prototype, ["push"]);

function messageFixture(username?: string): Message {
  return {
    message_id: 1,
    date: 1,
    chat: {
      id: BENCHMARK_CHAT_ID,
      type: "supergroup",
      title: "Performance fixture",
    },
    from: {
      id: 42,
      is_bot: false,
      first_name: "Stable",
      last_name: "Sender",
      username,
    },
  };
}

function senderScenario(username?: string): Scenario {
  const message: Message = messageFixture(username);
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += cacheSender(message) ?? 0;
      }
      return checksum;
    },
    reset: (): void => {
      userCache.clear();
      senderUsernameCache.clear();
    },
    probes: { cacheSender },
  };
}

function aiActivityScenario(): Scenario {
  let now: number = BENCHMARK_EPOCH_MS;
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        checksum += observeGroupMessageForAiReply(BENCHMARK_CHAT_ID, now);
      }
      return checksum;
    },
    reset: (): void => {
      clearAiReplyActivity();
      now = BENCHMARK_EPOCH_MS;
    },
    probes: { observeGroupMessageForAiReply },
  };
}

function aiActivityLruMissScenario(): Scenario {
  let now: number = BENCHMARK_EPOCH_MS;
  let chatId: number = BENCHMARK_CHAT_ID;
  return {
    iterations: 20_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        chatId -= 1;
        checksum += observeGroupMessageForAiReply(chatId, now);
      }
      return checksum;
    },
    reset: (): void => {
      clearAiReplyActivity();
      now = BENCHMARK_EPOCH_MS;
      chatId = BENCHMARK_CHAT_ID;
    },
    probes: { observeGroupMessageForAiReply },
  };
}

function linkedTimestampWindowScenario(): Scenario {
  const timestamps: LinkedQueue<number> = new LinkedQueue();
  let now: number = BENCHMARK_EPOCH_MS;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        trimSlidingWindow({ timestamps, windowMs: 165, now });
        timestamps.push(now);
      }
      return timestamps.size;
    },
    reset: (): void => {
      timestamps.clear();
      now = BENCHMARK_EPOCH_MS;
    },
    probes: {
      trimSlidingWindow,
      ...prototypeProbes("LinkedQueue", LinkedQueue.prototype, ["push"]),
    },
  };
}

function timestampWindowScenario(
  createWindow: () => TimestampWindow,
  probes: Readonly<Record<string, JitProbe>>
): Scenario {
  const timestamps: TimestampWindow = createWindow();
  let now: number = BENCHMARK_EPOCH_MS;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        timestamps.trim(165, now);
        timestamps.push(now);
      }
      return timestamps.size;
    },
    probes,
  };
}

function coldTimestampWindowScenario(
  createWindow: () => TimestampWindow,
  probes: Readonly<Record<string, JitProbe>>
): Scenario {
  const timestamps: TimestampWindow[] = [];
  return {
    iterations: 15_000,
    run: (iterations: number): number => {
      timestamps.length = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const window: TimestampWindow = createWindow();
        window.push(index);
        timestamps.push(window);
      }
      return timestamps.length;
    },
    reset: (): void => {
      timestamps.length = 0;
    },
    probes,
  };
}

function rollingBufferScenario(
  createBuffer: () => RollingBuffer,
  probes: Readonly<Record<string, JitProbe>>
): Scenario {
  const buffer: RollingBuffer = createBuffer();
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        buffer.push(index);
        if (buffer.size === 150) {
          for (let removed: number = 0; removed < 75; removed += 1) {
            checksum += buffer.shift() ?? 0;
          }
          checksum += buffer.last(75)[0] ?? 0;
        } else if (buffer.size === 75) {
          checksum += buffer.last(75)[0] ?? 0;
        }
      }
      return checksum;
    },
    reset: (): void => {
      buffer.clear();
    },
    probes,
  };
}

function adEmptyMetadataScenario(): Scenario {
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const sample: string = AD_SAMPLE_TEXTS[index % AD_SAMPLE_TEXTS.length] ?? "";
        const linkedText: string = appendLinkUrls(sample, EMPTY_LINK_URLS);
        const context: AdSampleContext | undefined = boundSampleContext(undefined);
        const text: string = context === undefined
          ? linkedText
          : claimSampleContextParts(linkedText, context, EMPTY_AD_ENTRIES);
        checksum += text.length;
      }
      return checksum;
    },
    // 本场景走的是「无元数据」那条分支：boundSampleContext 恒返回 undefined，
    // claimSampleContextParts 永远不会被调用，因此不登记它。
    probes: { appendLinkUrls, boundSampleContext },
  };
}

function adWireCloneScenario(): Scenario {
  const message: AdCandidateMessage = {
    type: "adCandidate",
    chatId: BENCHMARK_CHAT_ID,
    senderId: 42,
    messageId: 1,
    text: "ordinary message",
    label: "@stable_user",
    isChannel: false,
    blocked: false,
    justJoined: false,
  };
  return {
    iterations: 200_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const cloned: AdCandidateMessage = structuredClone(message);
        checksum += cloned.text.length;
      }
      return checksum;
    },
  };
}

function selfSentEmptyScenario(): Scenario {
  return {
    iterations: 2_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        if (isSelfSent(BENCHMARK_CHAT_ID, index)) checksum += 1;
      }
      return checksum;
    },
    reset: (): void => {
      for (const timer of sentMessages.values()) clearTimeout(timer);
      sentMessages.clear();
    },
    probes: { isSelfSent },
  };
}

/**
 * 每条群消息都要走的编排主干（`auto/message/index.ts` 的 handleIncomingMessage）。
 *
 * 其余场景量的都是叶子工具，而叶子各自快不等于串起来快；这一条量的是真正跑在
 * 每条消息上的那串固定调用：recordChatTitleFromChat → cacheSender → getChatState
 * → observeGroupMessageForAiReply → getActiveCopyIn → isQuietUntilActive →
 * isAiChatActiveIn → handleProactiveMessageActions。
 *
 * **fixture 必须是「无可复制内容」的消息**，这是本场景零副作用的依据，不是随手
 * 挑的：没有 `text`，洗澡触发的第一个条件就不成立；`hasCopyableContent` 为 false，
 * 随机复读（`RANDOM_ECHO_PROBABILITY` = 1/100）也进不去。两道门一关，
 * `sendMessage`/`echoMessage` 在这条路径上不可达。落盘同理——`recordChatTitle`
 * 先查 `isInitEnabled !== true`，而基准进程从不 loadState，
 * `getChatState` 恒返回 DEFAULT_CHAT_STATE，因此 `saveStateInBackground` 也不可达。
 * 部署机上 bot 常驻运行、共用同一份 state.json 和 token，这两条不可达性是本场景
 * 能安全存在的前提；改 fixture 前必须重新验证它们。
 *
 * 覆盖范围要说清楚：AI 关闭时不进各载荷 handler（生产同理），因此这条量的是
 * 「所有消息共担的那段」，不含 AI 开启后的文本/贴纸分支。
 */
function incomingMessageSpineScenario(): Scenario {
  const chat: Message["chat"] = {
    id: BENCHMARK_CHAT_ID,
    type: "supergroup",
    title: "Performance fixture",
  };
  const message: Message = {
    message_id: 1,
    date: 1,
    chat,
    from: { id: 42, is_bot: false, first_name: "Stable", last_name: "Sender" },
    pinned_message: { message_id: 0, date: 0, chat },
  };
  const ctx: Context = {
    msg: message,
    me: { id: 4242, is_bot: true, first_name: "Tensai", username: "tensai_bot" },
  } as unknown as Context;
  return {
    iterations: 200_000,
    run: async (iterations: number): Promise<number> => {
      for (let index: number = 0; index < iterations; index += 1) {
        await handleIncomingMessage(ctx);
      }
      return iterations;
    },
    reset: (): void => {
      clearAiReplyActivity();
      userCache.clear();
      senderUsernameCache.clear();
    },
    probes: { handleIncomingMessage, cacheSender, observeGroupMessageForAiReply },
  };
}

/**
 * 一条 AI 记录进入逐字缓存时的构造成本（workers/aiChat/bufferedMessage.ts）。
 *
 * 输入刻意混合四种「可选字段有没有」的组合：生产上正是这种混合让条件展开写法
 * 分裂出多个隐藏类。定形之后本场景量的是同一份工作在单一形状下的成本。
 */
const RECORD_SOURCES: readonly AiRecordContext[] = [
  {
    chatId: BENCHMARK_CHAT_ID, senderId: 101, firstName: "Alice", lastName: "Chen",
    username: "alice_dev", messageId: 1, replyTo: undefined, forwardedFrom: undefined,
    persistImmediately: false,
  },
  {
    chatId: BENCHMARK_CHAT_ID, senderId: 102, firstName: "Bob", lastName: "",
    username: undefined, messageId: 2, replyTo: undefined,
    forwardedFrom: "频道 [id:-100666] 东京日报", persistImmediately: false,
  },
  {
    chatId: BENCHMARK_CHAT_ID, senderId: 103, firstName: "Carol", lastName: "T",
    username: "carol", messageId: 3,
    replyTo: {
      messageId: 2, id: 102, firstName: "Bob", lastName: "", username: undefined,
      text: "被回复的原文", quote: undefined, forwardedFrom: undefined,
    },
    forwardedFrom: undefined, persistImmediately: false,
  },
  {
    chatId: BENCHMARK_CHAT_ID, senderId: 104, firstName: "Dave", lastName: "",
    username: undefined, messageId: 4, replyTo: undefined, forwardedFrom: undefined,
    persistImmediately: false,
  },
];

const RECORD_TEXTS: readonly string[] = [
  "今天天气不错", "在吗 有人吗", "哈哈哈哈哈", "这个功能怎么用",
];

function bufferedMessageBuildScenario(): Scenario {
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const source: AiRecordContext = RECORD_SOURCES[index % RECORD_SOURCES.length]!;
        const entry: BufferedMessage | null = buildBufferedMessage(
          source,
          RECORD_TEXTS[index % RECORD_TEXTS.length]!,
          BENCHMARK_EPOCH_MS + index
        );
        checksum += entry === null ? 0 : entry.text.length;
      }
      return checksum;
    },
    probes: { buildBufferedMessage },
  };
}

/**
 * 一次 AI 回复要付的转录渲染：把整条热区（上限 COMPACT_BATCH_SIZE 档，这里取
 * 生产同量级的 150 条）逐行拼成提示词。
 *
 * 这是 BufferedMessage 形状是否稳定的**读取侧**。缓存在场景构造时建好，采样
 * 只量渲染，不把构造成本混进来。
 *
 * **实测定形之后这条读数没有变化**（定形前 88.9~93.8k，定形后 89.9~91.0k，
 * 各 3~4 次独立进程，区间完全重叠），如实记在这里免得后来者据形状理论推断
 * 出一个并不存在的收益：这段的成本压倒性地在拼串本身，属性读取那点差异淹没
 * 在里面。定形真正的收益在构造侧（见 buffered-message-build）。本场景保留的
 * 意义是当**回归哨兵**——转录渲染是每次 AI 回复的必经之地。
 */
function transcriptRenderScenario(): Scenario {
  const messages: BufferedMessage[] = [];
  for (let index: number = 0; index < 150; index += 1) {
    const entry: BufferedMessage | null = buildBufferedMessage(
      RECORD_SOURCES[index % RECORD_SOURCES.length]!,
      RECORD_TEXTS[index % RECORD_TEXTS.length]!,
      BENCHMARK_EPOCH_MS + index
    );
    if (entry !== null) messages.push(entry);
  }
  return {
    iterations: 20_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += buildTieredVerbatimTranscript(messages).length;
      }
      return checksum;
    },
    probes: { buildTieredVerbatimTranscript },
  };
}

/** 带回复的消息每条都要解析一次回复引用（auto/message/facts.ts）。 */
function replyReferenceScenario(): Scenario {
  const chat: Message["chat"] = {
    id: BENCHMARK_CHAT_ID, type: "supergroup", title: "Performance fixture",
  };
  // grammY 的 reply_to_message 用的是不可再嵌套的 ReplyMessage，显式标注它，
  // 别让 Message 的自嵌套字段污染这份 fixture 的类型。
  const replied: NonNullable<Message["reply_to_message"]> = {
    message_id: 40, date: 1, chat,
    from: { id: 456, is_bot: false, first_name: "Bob", username: "bob_dev" },
    text: "被回复的原文",
    reply_to_message: undefined,
  };
  const messages: readonly Message[] = [
    { message_id: 41, date: 1, chat, from: { id: 123, is_bot: false, first_name: "Alice" }, text: "回复一句", reply_to_message: replied },
    { message_id: 42, date: 1, chat, from: { id: 123, is_bot: false, first_name: "Alice" }, text: "带引用", reply_to_message: replied, quote: { text: "原文", position: 0, is_manual: true } },
    { message_id: 43, date: 1, chat, from: { id: 123, is_bot: false, first_name: "Alice" }, text: "没有回复" },
  ];
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += resolveReplyReference(messages[index % messages.length]!)?.text.length ?? 0;
      }
      return checksum;
    },
    probes: { resolveReplyReference },
  };
}

/**
 * 提及判定。两个变体分开量：`mention-facts` 混入带 entity 的消息（真正扫实体
 * 表那条路），`mention-facts-plain` 全是无 entity 的普通消息（生产上占绝大多数，
 * 量的是早退成本）。
 */
function mentionFactsScenario(withEntities: boolean): Scenario {
  const chat: Message["chat"] = {
    id: BENCHMARK_CHAT_ID, type: "supergroup", title: "Performance fixture",
  };
  const plain: readonly Message[] = [
    { message_id: 1, date: 1, chat, text: "今天天气不错" },
    { message_id: 2, date: 1, chat, text: "在吗" },
    { message_id: 3, date: 1, chat, text: "这个怎么弄呢" },
  ];
  const mentioned: Message = {
    message_id: 4, date: 1, chat,
    text: "@tensai_bot 你怎么看 @someone_else",
    entities: [
      { type: "mention", offset: 0, length: 11 },
      { type: "mention", offset: 15, length: 14 },
    ],
  };
  const messages: readonly Message[] = withEntities
    ? [plain[0]!, plain[1]!, mentioned, plain[2]!]
    : plain;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const facts: MentionFacts = resolveMentionFacts(
          messages[index % messages.length]!, 4242, "tensai_bot"
        );
        if (facts.isMentioned) checksum += 1;
        if (facts.hasOtherMention) checksum += 2;
      }
      return checksum;
    },
    probes: { resolveMentionFacts },
  };
}

/**
 * 日志脱敏在「正文一个密钥都不含」这条主路径上的成本。
 *
 * 每条日志的每个参数都要跑一遍，而生产上几乎所有日志正文都不含密钥；因此这条
 * 早退路径才是它的常态，值得单列一个场景盯着。
 */
const BENCHMARK_SECRETS: readonly string[] = [
  "1234567890:AAF-benchmark-token-value",
  "sk-benchmark-deepseek-key",
  "AIzaSyBenchmarkGeminiKeyValue",
];

const BENCHMARK_LOG_LINES: readonly string[] = [
  "Chat title refresh progress: 50/120, elapsed=310ms.",
  "Anti-Raid Worker rejected an ad detection candidate from chat -1001234567890.",
  "Failed to refresh chat title for chat -1009876543210:",
];

function redactCleanLogScenario(): Scenario {
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += redactSecretsInText(
          BENCHMARK_LOG_LINES[index % BENCHMARK_LOG_LINES.length]!,
          BENCHMARK_SECRETS
        ).length;
      }
      return checksum;
    },
    probes: { redactSecretsInText },
  };
}

/**
 * 共享常量表的读取代价，以 LUCK_TIERS 为样本。
 *
 * 循环体逐字照抄 commands/luckChallenge/draw.ts 的 drawLuckTier（那个函数没有
 * 导出，但它就是这张表在生产上唯一的读法：按权重累加线性扫），读的也是生产
 * 那一份常量本体，不另造 fixture。
 *
 * 存在的理由是给「常量表要不要 Object.freeze」这个决定留一把尺子：JSC 对冻结
 * 数组的下标读取和 for-of 都没有快路径，量级差一个数量级。
 */
function luckTierTableScenario(): Scenario {
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const roll: number = index % 100;
        let cumulative: number = 0;
        for (const tier of LUCK_TIERS) {
          cumulative += tier.weight;
          if (roll < cumulative) { checksum += tier.label.length; break; }
        }
      }
      return checksum;
    },
  };
}

export function createScenario(name: ScenarioName): Scenario {
  switch (name) {
    case "sender-no-username":
      return senderScenario();
    case "sender-stable-username":
      return senderScenario("Stable_User");
    case "ai-activity-window":
      return aiActivityScenario();
    case "ai-activity-lru-miss":
      return aiActivityLruMissScenario();
    case "ad-empty-metadata":
      return adEmptyMetadataScenario();
    case "ad-wire-clone":
      return adWireCloneScenario();
    case "array-timestamp-window":
      return timestampWindowScenario(
        (): TimestampWindow => new ArrayTimestampWindow(),
        ARRAY_WINDOW_PROBES
      );
    case "float64-timestamp-window":
      return timestampWindowScenario(
        (): TimestampWindow => new Float64TimestampWindow(),
        FLOAT64_WINDOW_PROBES
      );
    case "array-timestamp-cold":
      return coldTimestampWindowScenario(
        (): TimestampWindow => new ArrayTimestampWindow(),
        ARRAY_WINDOW_COLD_PROBES
      );
    case "float64-timestamp-cold":
      return coldTimestampWindowScenario(
        (): TimestampWindow => new Float64TimestampWindow(),
        FLOAT64_WINDOW_COLD_PROBES
      );
    case "linked-timestamp-window":
      return linkedTimestampWindowScenario();
    case "linked-rolling-buffer":
      return rollingBufferScenario(
        (): RollingBuffer => new LinkedQueue<number>(),
        prototypeProbes("LinkedQueue", LinkedQueue.prototype, ["push", "shift", "last"])
      );
    case "bounded-rolling-buffer":
      return rollingBufferScenario(
        (): RollingBuffer => new BoundedDeque<number>(150),
        prototypeProbes("BoundedDeque", BoundedDeque.prototype, ["push", "shift", "last"])
      );
    case "self-sent-empty":
      return selfSentEmptyScenario();
    case "incoming-message-spine":
      return incomingMessageSpineScenario();
    case "buffered-message-build":
      return bufferedMessageBuildScenario();
    case "transcript-render":
      return transcriptRenderScenario();
    case "reply-reference":
      return replyReferenceScenario();
    case "mention-facts":
      return mentionFactsScenario(true);
    case "mention-facts-plain":
      return mentionFactsScenario(false);
    case "redact-clean-log":
      return redactCleanLogScenario();
    case "luck-tier-table":
      return luckTierTableScenario();
  }
}
