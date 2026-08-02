import type { BufferedMessage, BufferedReplyReference, ReplyChainLink } from "../../../types/aiChat/memory";
import type { AiSpeakerSnapshot } from "../../../types/aiChat/speaker";
import { FALLBACK_SPEAKER_NAME } from "../../../consts/auto";
import { COMPACT_BATCH_SIZE, REPLY_CHAIN_NODE_MAX_CHARS } from "../../../consts/aiChat/memory";
import {
  FORWARD_TAG_HINT,
  forwardTagTemplate,
  REPLY_CHAIN_SNAPSHOT_TAG,
  REPLY_TAG_HINT,
  replyChainTemplate,
  replyTagTemplate,
  TRANSCRIPT_LINE_FORMAT_HINT,
} from "../../../consts/aiChat/prompts/transcript";
import { truncateInline } from "../../../libs/text";

/**
 * 发言人的显示名：first/last 拼接，都没有则给个占位。
 *
 * 只有两个字段，却是转录里调用最密集的函数之一——每条转录行一次，加上每条
 * 回复标注、回复链每一跳各一次，一次 AI 回复要跑一两百遍。原先的
 * `[a,b].filter(...).join(" ").trim()` 为此每次造一个数组、一个过滤后数组和
 * 两个中间串；直接分支后实测「只有 first」这条最常见路径 289~313 → 49~53 ns/op，
 * 两个字段都有时也稳定更快。语义逐字对齐（含全空白字段与两者皆空的占位回退）。
 */
function displaySpeakerName(speaker: AiSpeakerSnapshot): string {
  const first: string = speaker.firstName;
  const last: string = speaker.lastName;
  if (first && last) return `${first} ${last}`.trim() || FALLBACK_SPEAKER_NAME;
  // `|| ""` 不是多余的：类型上两个字段都是必填 string，但这里要跟被替换掉的
  // `[a,b].filter(Boolean).join(" ")` 保持完全同等的健壮性——那种写法遇到
  // undefined 会安全退化成占位符，而 `(first || last).trim()` 会抛 TypeError。
  // 转录是回复链路的必经之地，不值得为省一次 `|| ""` 换一条可能抛异常的路径。
  return (first || last || "").trim() || FALLBACK_SPEAKER_NAME;
}

export function displayBufferedMessageName(message: BufferedMessage): string {
  return displaySpeakerName(message);
}

/** 转发来源标注，明确正文并非发送者本人所写；模板与说明文案共用（见
 * consts/aiChat/prompts/transcript.ts）。 */
function formatForwardTag(forwardedFrom: string | undefined): string {
  return forwardedFrom ? forwardTagTemplate(forwardedFrom) : "";
}

/** 回复关系以内嵌元数据呈现，模型无需靠相邻消息猜测被回复对象。 */
export function formatReplyReference(reference: BufferedReplyReference): string {
  const usernameTag: string = reference.username ? ` [username:@${reference.username.replace(/^@+/, "")}]` : "";
  const quote: string = reference.quote ? `；精确引用片段：「${reference.quote}」` : "";
  return replyTagTemplate({
    target: `[message_id:${reference.messageId}] [id:${reference.id}]${usernameTag} ${displaySpeakerName(reference)}`,
    text: reference.text,
    forwardTag: formatForwardTag(reference.forwardedFrom),
    quote,
  });
}

/**
 * 多层回复链标注：单跳回复标注只覆盖第一跳，链 ≥2 跳时在回复任务区块补
 * 全路径（见 workers/aiChat/promptContext.ts）。各跳身份与转发来源标记和
 * 转录行一致，正文按 REPLY_CHAIN_NODE_MAX_CHARS 截断。已滑出热区、仅靠
 * 上一跳回复快照保留的链尾显式标记；不足 2 跳时返回空串。
 */
export function formatReplyChain(triggerMessageId: number, chain: ReplyChainLink[]): string {
  if (chain.length < 2) return "";
  const links: string[] = chain.map((link: ReplyChainLink): string => {
    const usernameTag: string = link.username ? ` [username:@${link.username.replace(/^@+/, "")}]` : "";
    const snapshotTag: string = link.snapshotOnly ? ` ${REPLY_CHAIN_SNAPSHOT_TAG}` : "";
    return `[message_id:${link.messageId}] [id:${link.id}]${usernameTag} ${displaySpeakerName(link)}${formatForwardTag(link.forwardedFrom)}${snapshotTag}：「${truncateInline(link.text, REPLY_CHAIN_NODE_MAX_CHARS)}」`;
  });
  return replyChainTemplate(triggerMessageId, links);
}

/**
 * 把一条缓存消息格式化成喂给模型的一行：先拼记录时已格式化好的发送时间，
 * 再标出 id 避免重名混淆身份；有公开 username 时额外给出映射，让模型能把
 * 消息正文里的 @username 认回具体发言人。旧缓存没有 username 时保持原格式。
 */
export function formatBufferedMessageLine(message: BufferedMessage): string {
  // message_id 段直接写进最终模板，不再先落一个 messageIdTag 中间串：那一步
  // 只是把它先物化成字符串、紧接着又拼进大模板。实测 401 → 192 ns/op、
  // 6.53 → 5.52 obj/op。usernameTag/replyTag 仍留变量——它们是条件分支，
  // 内联成三元反而让这行长到读不动，且省不掉那次物化。
  const usernameTag: string = message.username ? ` [username:@${message.username.replace(/^@+/, "")}]` : "";
  const replyTag: string = message.replyTo ? formatReplyReference(message.replyTo) : "";
  return `[${message.at}] [message_id:${message.messageId}] [id:${message.id}]${usernameTag} ${displayBufferedMessageName(message)}${formatForwardTag(message.forwardedFrom)}${replyTag}：${message.text}`;
}

/**
 * 转录格式说明。整段由编译期常量拼成、与消息内容无关，因此提到模块级只拼一次。
 *
 * 原先写在 buildTieredVerbatimTranscript 内部，每次调用重建一遍这 346 个字符：
 * 实测 315 ns / 5.9 个对象 / 190 B，而提成常量后是 24 ns / 0.02 个对象。
 */
const TRANSCRIPT_FORMAT_INSTRUCTION: string =
  `每行格式为${TRANSCRIPT_LINE_FORMAT_HINT}，其中 message_id/username 标记在旧记录没有对应信息时省略。` +
  `若名字后出现「${REPLY_TAG_HINT}」则表示这条消息明确回复的对象和原文，精确引用片段是用户选中的部分。` +
  `若出现「${FORWARD_TAG_HINT}」则表示这条消息（或被回复的原消息）是从别处转发的，正文出自转发来源而非发送者本人；来源身份同样以 [id:]/[username:@] 标记区分，来源账号隐藏时只有显示名。` +
  "行首方括号里是发送时间（东京时间 UTC+9）；同名的人以 id 区分，正文里的 @用户名用 username 标记映射回具体的人。";

/**
 * 把 [start, end) 区间的消息逐行拼成一段，行间以换行分隔。
 *
 * 只用一个预分配好长度的数组再 `join`，不走 `slice().map().join()`：后者会为
 * 一次转录额外造出两个切片数组和两个映射数组（150 条上限时就是四个上百元素的
 * 中间容器），而它们唯一的用途就是立刻被 join 掉。
 *
 * 也**不能**改成 `out += line` 那样循环拼串。看着更省，实测反而把分配放大一个
 * 数量级：JSC 每次 `+=` 都挂一个 rope 节点，150 条那档实测 14 → 1635 个对象、
 * 22 → 52 KB。`join` 一次成串，是这三种写法里唯一时间和分配都不吃亏的。
 *
 * 不给 `end - start` 补 `Math.max(0, …)`：唯一的调用方就在紧邻的下一个函数，
 * 两次都从 `hotStart = Math.max(0, len - COMPACT_BATCH_SIZE)` 派生，必然落在
 * `[0, len]` 内，区间不可能倒置。真有人加了传反的第三个调用点，`new Array(-n)`
 * 当场抛 RangeError，比静默拼出一段空转录更容易发现。
 */
function joinMessageLines(messages: BufferedMessage[], start: number, end: number): string {
  const lines: string[] = new Array<string>(end - start);
  for (let index: number = start; index < end; index += 1) {
    lines[index - start] = formatBufferedMessageLine(messages[index]!);
  }
  return lines.join("\n");
}

/**
 * 把逐字缓存按判断优先级分层：最新 COMPACT_BATCH_SIZE 条始终单列为最热
 * 记忆；更早、但仍未滑出逐字缓存的上一块列为次要背景。这样模型不会把
 * 压缩摘要、上一块逐字镜像和正在发生的对话等权看待。
 */
export function buildTieredVerbatimTranscript(messages: BufferedMessage[]): string {
  const hotStart: number = Math.max(0, messages.length - COMPACT_BATCH_SIZE);
  return (
    TRANSCRIPT_FORMAT_INSTRUCTION + "\n\n" +
    (hotStart > 0
      ? "【较早逐字记录（次要背景）】这些记录仍是原文，但判断当前话题和应答对象时应让位于下方最热记忆：\n" +
        joinMessageLines(messages, 0, hotStart) +
        "\n\n"
      : "") +
    `【最热记忆（重要判断标准，最新最多 ${COMPACT_BATCH_SIZE} 条）】这是滑动缓存里最新、最应优先关注的逐字消息。` +
    "判断当前话题、人物指代、@对象、情绪和该回应谁时，必须优先依据本段；最后一条是最新消息：\n" +
    joinMessageLines(messages, hotStart, messages.length)
  );
}

/** 已滑出逐字区的压缩摘要：只作为长期背景纳入理解，不参与判断当前状态
 * （两层仲裁见 consts/aiChat/prompts/memory.ts 的
 * CHAT_MEMORY_PRIORITY_INSTRUCTION）。 */
export function buildColdMemoryBlock(summaries: string[]): string {
  if (summaries.length === 0) return "";
  return (
    "【冷记忆（长期背景）】下列内容是更早对话的压缩摘要（按时间从旧到新），只用于理解长期话题、称呼、人物关系和前因后果，不用于判断当前状态；" +
    "它与较新的逐字记录不一致时，只说明情况后来变了，当前状态以逐字记录为准：\n" +
    summaries.map((summary: string, index: number): string => `${index + 1}. ${summary}`).join("\n")
  );
}
