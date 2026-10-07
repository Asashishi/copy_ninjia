import type { BufferedMessage, BufferedReplyReference } from "../../../types/aiChat/memory";
import type { AiSpeakerSnapshot } from "../../../types/aiChat/speaker";
import { FALLBACK_SPEAKER_NAME } from "../../../consts/auto";
import {
  COMPACT_BATCH_SIZE,
  TIER_BOUNDARY_ALIGNMENT,
  TRANSCRIPT_SETTLED_SEGMENT_SIZE,
} from "../../../consts/aiChat/memory";
import {
  COLD_MEMORY_BLOCK_HEADER,
  EARLIER_VERBATIM_BLOCK_HEADER,
  FORWARD_ROSTER_BLOCK_NAME,
  forwardTagTemplate,
  HOT_MEMORY_BLOCK_HEADER,
  messageNumberTag,
  REPLY_TARGET_EVICTED_TAG,
  replyPointerTemplate,
  replyQuoteInlineTemplate,
  replyQuoteTemplate,
  replyTagTemplate,
  rosterEntryTemplate,
  SELF_ROSTER_CODE,
  SELF_SPEAKER_NAME,
  SPEAKER_ROSTER_BLOCK_NAME,
  transcriptDateHeader,
} from "../../../consts/aiChat/prompts/transcript";
import { stripLeadingAtSigns } from "../../../libs/text";

/**
 * 发言人的显示名：first/last 拼接，都没有则给个占位。
 *
 * 每条转录行与回复标注都会调用；直接分支拼接，不创建临时数组；全空白字段与
 * 两者皆空时回退到占位符。
 */
export function displaySpeakerName(speaker: AiSpeakerSnapshot): string {
  const first: string = speaker.firstName;
  const last: string = speaker.lastName;
  if (first && last) return `${first} ${last}`.trim() || FALLBACK_SPEAKER_NAME;
  // `|| ""` 使越过类型边界的 undefined 输入同样退化成占位符。
  return (first || last || "").trim() || FALLBACK_SPEAKER_NAME;
}

/**
 * 名册、引用与唤起者共用身份段。仅 selfId 对应的发言人使用代称并省略 username，
 * 其他身份保留 `[id:…] [username:@…] 显示名`，没有公开用户名时省略中段。
 */
export function formatSpeakerIdentity(speaker: AiSpeakerSnapshot, selfId?: number): string {
  if (speaker.id === selfId) return `[id:${speaker.id}] ${SELF_SPEAKER_NAME}`;
  const usernameTag: string = speaker.username ? ` [username:@${stripLeadingAtSigns(speaker.username)}]` : "";
  return `[id:${speaker.id}]${usernameTag} ${displaySpeakerName(speaker)}`;
}

/** 转发来源标注，明确正文并非发送者本人所写；模板与说明文案共用（见
 * consts/aiChat/prompts/transcript.ts）。 */
function formatForwardTag(forwardedFrom: string | undefined): string {
  return forwardedFrom ? forwardTagTemplate(forwardedFrom) : "";
}

/** 回复关系以内嵌元数据呈现。 */
function formatReplyReference(reference: BufferedReplyReference, selfId: number | undefined): string {
  const quote: string = reference.quote ? replyQuoteInlineTemplate(reference.quote) : "";
  return replyTagTemplate({
    target: `[message_id:${reference.messageId}] ${formatSpeakerIdentity(reference, selfId)}`,
    text: reference.text,
    forwardTag: formatForwardTag(reference.forwardedFrom),
    quote,
  });
}

/**
 * 把一条缓存消息格式化成**自包含**的一行：时间、消息号、完整身份、转发来源和
 * 被回复原文全都内嵌，不依赖任何外部名册。
 *
 * 冷历史压缩由 workers/aiChat/compaction.ts 调用：每批 COMPACT_BATCH_SIZE 条消息
 * 一次模型调用，没有名册可查；说明文案见 consts/aiChat/prompts/memory.ts 的
 * SUMMARY_SYSTEM_PROMPT。回复转录使用名册 + 编号的紧凑渲染，见
 * buildTieredVerbatimTranscript。
 */
export function formatBufferedMessageLine(message: BufferedMessage, selfId?: number): string {
  const isSelf: boolean = message.id === selfId;
  const usernameTag: string = !isSelf && message.username ? ` [username:@${stripLeadingAtSigns(message.username)}]` : "";
  const replyTag: string = message.replyTo ? formatReplyReference(message.replyTo, selfId) : "";
  return `[${message.at}] [message_id:${message.messageId}] [id:${message.id}]${usernameTag} ${isSelf ? SELF_SPEAKER_NAME : displaySpeakerName(message)}${formatForwardTag(message.forwardedFrom)}${replyTag}：${message.text}`;
}

/** buildTieredVerbatimTranscript 的一次渲染状态：编号表 + 哪些行要带消息号。 */
interface TranscriptContext {
  /** 本机器人 ID；名册与窗口外引用都据此选择统一代称。 */
  readonly selfId: number;
  /** 发送者 id → 行内编号；机器人自己固定是 SELF_ROSTER_CODE。
   *  每渲染一行查一次；speakerSnapshots 只在拼名册时遍历一遍。 */
  readonly speakers: Map<number, string>;
  /** 发送者 id → 窗口内最后一次出现时的身份快照，供名册取显示名与 username；
   *  取法与回复任务里唤起者声明一致（见 workers/aiChat/promptContext.ts 的 resolveInvoker）。
   *  Map 的插入顺序不因覆盖而改变，名册顺序为首次发言先后。 */
  readonly speakerSnapshots: Map<number, AiSpeakerSnapshot>;
  /** 转发来源原串 → 行内编号（f1、f2……）。 */
  readonly origins: Map<string, string>;
  /** 需要写出 #消息号 的消息：本段内被回复过的目标，加上本轮触发消息。 */
  readonly numbered: Set<number>;
  /** 本段内确实存在的消息号；决定回复标注走指针还是退回内嵌快照。 */
  readonly present: Set<number>;
  /** 入参里重复的 message_id 条数，即 `messages.length - present.size`。
   *  >0 时调用方去重后重建一次上下文（见 buildTieredVerbatimTranscript）。 */
  readonly duplicates: number;
}

/** renderRange 要渲染的半开区间 [start, end) 与已定切点的记录位置。 */
interface TranscriptRange {
  readonly start: number;
  readonly end: number;
  /** 本区间渲染结果的第一个字符在整段转录里的下标。 */
  readonly offset: number;
  /** 最新消息所在格的起始序号；序号不超过它的格边界才记切点。 */
  readonly settledEnd: number;
  /** 切点按整段转录内的下标升序追加到这里。 */
  readonly settledOffsets: number[];
}

/**
 * 渲染结果包含转录文本、行内编号和同源的单跳引用渲染函数：
 * 转录之外点名某个人或某条消息的地方（唤起者声明、排队补跑的回复引用）
 * 使用与转录行同一套写法。
 */
export interface RenderedTranscript {
  readonly text: string;
  /** 发送者 id → 行内编号（uN / me）。名册里没有的人查不到，由调用方退回完整身份段。 */
  readonly codeOf: ReadonlyMap<number, string>;
  /** 转录之外引用某条被回复消息时的紧凑写法：在窗口内就给指针，否则退回内嵌快照。 */
  readonly replyReference: (reference: BufferedReplyReference) => string;
  /**
   * 已定切点：text 内的 UTF-16 下标，升序。窗口按消息序号每 TRANSCRIPT_SETTLED_SEGMENT_SIZE
   * 条一格，只取最新消息所在格之前的格边界；切点紧跟上一格最后一条消息的正文，落在其后的
   * 换行、日期行与分层标题之前，因此分层边界移动前后同一格边界的下标不变。
   * 切分拼回去与 text 逐字相同。
   */
  readonly settledOffsets: readonly number[];
}

export interface TieredTranscriptOptions {
  /** 机器人自己的账号 id：它在名册里固定拿 SELF_ROSTER_CODE。 */
  readonly selfId: number;
  /** 本轮触发消息的 message_id；即使尚未被回复也保留消息号，供模型定位当前触发。 */
  readonly triggerMessageId: number;
}

/**
 * 扫一遍窗口，定下编号表与哪些行需要消息号。
 *
 * 转发来源只在会被渲染出来时才占编号：行自身的 forwardedFrom 一定渲染，
 * 被回复消息的 forwardedFrom 只在目标已滑出、退回内嵌快照时渲染。
 */
function buildTranscriptContext(
  messages: BufferedMessage[],
  { selfId, triggerMessageId }: TieredTranscriptOptions
): TranscriptContext {
  const present: Set<number> = new Set<number>();
  for (const message of messages) present.add(message.messageId);

  const speakers: Map<number, string> = new Map<number, string>();
  const speakerSnapshots: Map<number, AiSpeakerSnapshot> = new Map<number, AiSpeakerSnapshot>();
  const origins: Map<string, string> = new Map<string, string>();
  const numbered: Set<number> = new Set<number>();
  if (present.has(triggerMessageId)) numbered.add(triggerMessageId);

  // 编号单独计数：机器人占 SELF_ROSTER_CODE，不占 uN。
  let userCode: number = 0;
  for (const message of messages) {
    if (!speakers.has(message.id)) {
      speakers.set(message.id, message.id === selfId ? SELF_ROSTER_CODE : `u${(userCode += 1)}`);
    }
    // 每条都覆盖，留下最后一次的身份；只存引用，身份串在拼名册时按人拼一次。
    speakerSnapshots.set(message.id, message);
    if (message.forwardedFrom !== undefined && !origins.has(message.forwardedFrom)) {
      origins.set(message.forwardedFrom, `f${origins.size + 1}`);
    }
    const replyTo: BufferedReplyReference | undefined = message.replyTo;
    if (replyTo === undefined) continue;
    if (present.has(replyTo.messageId)) {
      numbered.add(replyTo.messageId);
    } else if (replyTo.forwardedFrom !== undefined && !origins.has(replyTo.forwardedFrom)) {
      origins.set(replyTo.forwardedFrom, `f${origins.size + 1}`);
    }
  }
  return { selfId, speakers, speakerSnapshots, origins, numbered, present, duplicates: messages.length - present.size };
}

/** 名册区块：编号到人、编号到转发来源各一段；没有转发时后一段整个不出现。
 *  两段都直接遍历 buildTranscriptContext 攒好的表。 */
function buildRosterBlock(context: TranscriptContext): string {
  const speakerLines: string[] = [];
  for (const [id, snapshot] of context.speakerSnapshots) {
    speakerLines.push(rosterEntryTemplate(context.speakers.get(id)!, formatSpeakerIdentity(snapshot, context.selfId)));
  }
  const originLines: string[] = [];
  for (const [origin, code] of context.origins) originLines.push(rosterEntryTemplate(code, origin));

  return (
    `${SPEAKER_ROSTER_BLOCK_NAME}上面转录的每一行只写编号，编号对应的人看这里；「${SELF_ROSTER_CODE}」就是你自己：\n` +
    speakerLines.join("\n") +
    (originLines.length > 0
      ? `\n\n${FORWARD_ROSTER_BLOCK_NAME}行内「${forwardTagTemplate("f…")}」对应的原始来源看这里：\n` + originLines.join("\n")
      : "")
  );
}

/**
 * 把 [start, end) 区间渲染成紧凑行，日期变化时插一条日期分隔行。
 *
 * 区间开头先写一条日期分隔行，每个分层区块自带日期。
 *
 * 逐行 `+=` 累加，不创建行数组。生产会在拼进提示词、跨线程 clone 或发送网络时
 * 展平 rope；对应基准必须用 `charCodeAt(length - 1)` 强制物化，不能只读 `.length`，
 * 见 scripts/perf/hotPaths/transcriptScenarios.ts。
 *
 * `first` 记录是否还没写出任何行，据此决定行前是否补换行。区间内部的格边界在写出该条消息的
 * 换行与日期行之前记切点；区间起点不在这里记（分层边界由调用方记，窗口起点不切）。
 */
function renderRange(
  messages: BufferedMessage[],
  context: TranscriptContext,
  { start, end, offset, settledEnd, settledOffsets }: TranscriptRange
): string {
  let rendered: string = "";
  let first: boolean = true;
  let lastDate: string = "";
  for (let index: number = start; index < end; index += 1) {
    const message: BufferedMessage = messages[index]!;
    if (index > start && index <= settledEnd && index % TRANSCRIPT_SETTLED_SEGMENT_SIZE === 0) {
      settledOffsets.push(offset + rendered.length);
    }
    // `at` 由记录侧格式化成「YYYY/MM/DD HH:MM:SS」；没有空格时整串当时间用、不发日期行。
    const at: string = message.at;
    const separator: number = at.indexOf(" ");
    // 同一天判定：日期段长度与前缀都相同；只在换天时 slice 出日期串。
    if (separator > 0 && (separator !== lastDate.length || !at.startsWith(lastDate))) {
      lastDate = at.slice(0, separator);
      if (!first) rendered += "\n";
      rendered += transcriptDateHeader(lastDate);
      first = false;
    }
    const clock: string = separator > 0 ? at.slice(separator + 1) : at;
    const numberTag: string = context.numbered.has(message.messageId) ? ` ${messageNumberTag(message.messageId)}` : "";
    const forwardTag: string = message.forwardedFrom === undefined
      ? ""
      : forwardTagTemplate(context.origins.get(message.forwardedFrom) ?? message.forwardedFrom);
    if (!first) rendered += "\n";
    rendered +=
      `[${clock}]${numberTag} ${context.speakers.get(message.id) ?? formatSpeakerIdentity(message, context.selfId)}${forwardTag}${formatCompactReplyTag(message.replyTo, context)}：${message.text}`;
    first = false;
  }
  return rendered;
}

/**
 * 紧凑回复标注。目标还在本段里就只留指针；目标已滑出窗口时退回内嵌快照，
 * 作者仍在名册里则用编号，否则写完整身份。精确引用片段两条路都保留。
 */
function formatCompactReplyTag(
  reference: BufferedReplyReference | undefined,
  context: TranscriptContext
): string {
  if (reference === undefined) return "";
  // 内嵌引用串只在「已滑出」分支里拼接；目标仍在窗口内时走指针分支。
  if (context.present.has(reference.messageId)) {
    return `${replyPointerTemplate(reference.messageId)}${reference.quote ? replyQuoteTemplate(reference.quote) : ""}`;
  }
  const identity: string = context.speakers.get(reference.id) ?? formatSpeakerIdentity(reference, context.selfId);
  const forwardTag: string = reference.forwardedFrom === undefined
    ? ""
    : forwardTagTemplate(context.origins.get(reference.forwardedFrom) ?? reference.forwardedFrom);
  return replyTagTemplate({
    target: `${REPLY_TARGET_EVICTED_TAG} ${identity}`,
    text: reference.text,
    forwardTag,
    quote: reference.quote ? replyQuoteInlineTemplate(reference.quote) : "",
  });
}

/**
 * 把逐字缓存按判断优先级分层：最新 COMPACT_BATCH_SIZE 条始终单列为最热
 * 记忆；更早、但仍未滑出逐字缓存的上一块列为次要背景。
 *
 * 行本身走紧凑渲染：身份、转发来源各出一次名册，行内只写编号；日期只在变化时
 * 单起一行；消息号只给真的会被引用的行；被回复消息只留指针。名册排在全部逐字行
 * 之后：窗口里出现新发言人只改动区块末尾，两次块轮换之间逐字行相对上一轮是纯追加。
 * settledOffsets 把转录切成按消息序号对齐的多段，切分不改变 text。
 *
 * 本段只出数据和分层标注；行格式的说明由 systemInstruction 里的
 * TRANSCRIPT_FORMAT_INSTRUCTION 给出（见 consts/aiChat/prompts/memory.ts）。
 */
export function buildTieredVerbatimTranscript(
  messages: BufferedMessage[],
  options: TieredTranscriptOptions
): RenderedTranscript {
  // 重复条数由 buildTranscriptContext 给出；有重复才去重并重建上下文。
  const scanned: TranscriptContext = buildTranscriptContext(messages, options);
  const deduped: BufferedMessage[] = scanned.duplicates === 0
    ? messages
    : dedupeByMessageId(messages, scanned.duplicates);
  const context: TranscriptContext = scanned.duplicates === 0
    ? scanned
    : buildTranscriptContext(deduped, options);
  // 边界按 TIER_BOUNDARY_ALIGNMENT 向上对齐，【最热记忆】恒不超过
  // COMPACT_BATCH_SIZE 条，与 HOT_MEMORY_BLOCK_HEADER 标题里的条数一致。
  const overflow: number = deduped.length - COMPACT_BATCH_SIZE;
  const hotStart: number = overflow <= 0
    ? 0
    : Math.ceil(overflow / TIER_BOUNDARY_ALIGNMENT) * TIER_BOUNDARY_ALIGNMENT;
  // 最新消息所在格的起点；窗口为空时为负，不记任何切点。
  const settledEnd: number =
    Math.floor((deduped.length - 1) / TRANSCRIPT_SETTLED_SEGMENT_SIZE) * TRANSCRIPT_SETTLED_SEGMENT_SIZE;
  const settledOffsets: number[] = [];
  const earlierLines: string = hotStart > 0
    ? renderRange(deduped, context, {
      start: 0,
      end: hotStart,
      offset: EARLIER_VERBATIM_BLOCK_HEADER.length,
      settledEnd,
      settledOffsets,
    })
    : "";
  // 分层边界是 TIER_BOUNDARY_ALIGNMENT 的整数倍，恒为格边界。切点同样紧跟上一条消息的正文、
  // 落在空行与【最热记忆】标题之前：边界后移一格时，这个位置在下一轮仍是同一个切点。
  if (hotStart > 0 && hotStart <= settledEnd) {
    settledOffsets.push(EARLIER_VERBATIM_BLOCK_HEADER.length + earlierLines.length);
  }
  const earlier: string = hotStart > 0 ? EARLIER_VERBATIM_BLOCK_HEADER + earlierLines + "\n\n" : "";
  const text: string =
    earlier +
    HOT_MEMORY_BLOCK_HEADER +
    renderRange(deduped, context, {
      start: hotStart,
      end: deduped.length,
      offset: earlier.length + HOT_MEMORY_BLOCK_HEADER.length,
      settledEnd,
      settledOffsets,
    }) +
    "\n\n" + buildRosterBlock(context);
  return {
    text,
    codeOf: context.speakers,
    replyReference: (reference: BufferedReplyReference): string => formatCompactReplyTag(reference, context),
    settledOffsets,
  };
}

/**
 * 同一个 message_id 的重复条目只保留最后一份（回填只落在后写入的那份上），使 #N 指针唯一。
 * 仅在 duplicates > 0 时由调用方调用。
 */
function dedupeByMessageId(messages: BufferedMessage[], duplicates: number): BufferedMessage[] {
  const kept: BufferedMessage[] = new Array<BufferedMessage>(messages.length - duplicates);
  const taken: Set<number> = new Set<number>();
  let cursor: number = kept.length - 1;
  for (let index: number = messages.length - 1; index >= 0; index -= 1) {
    const message: BufferedMessage = messages[index]!;
    if (taken.has(message.messageId)) continue;
    taken.add(message.messageId);
    kept[cursor] = message;
    cursor -= 1;
  }
  return kept;
}

/** 已滑出逐字区的压缩摘要：只作为长期背景纳入理解，不参与判断当前状态
 * （两层仲裁见 consts/aiChat/prompts/memory.ts 的
 * CHAT_MEMORY_PRIORITY_INSTRUCTION）。 */
export function buildColdMemoryBlock(summaries: string[]): string {
  if (summaries.length === 0) return "";
  return (
    COLD_MEMORY_BLOCK_HEADER +
    summaries.map((summary: string, index: number): string => `${index + 1}. ${summary}`).join("\n")
  );
}
