import type { BufferedMessage, BufferedReplyReference, ReplyChainLink } from "../../../types/aiChat/memory";
import type { AiSpeakerSnapshot } from "../../../types/aiChat/speaker";
import { FALLBACK_SPEAKER_NAME } from "../../../consts/auto";
import { COMPACT_BATCH_SIZE, REPLY_CHAIN_NODE_MAX_CHARS } from "../../../consts/aiChat/memory";
import {
  FORWARD_ROSTER_BLOCK_NAME,
  forwardTagTemplate,
  messageNumberTag,
  REPLY_CHAIN_SNAPSHOT_TAG,
  REPLY_TARGET_EVICTED_TAG,
  replyChainTemplate,
  replyPointerTemplate,
  replyQuoteInlineTemplate,
  replyQuoteTemplate,
  replyTagTemplate,
  rosterEntryTemplate,
  SELF_ROSTER_CODE,
  SPEAKER_ROSTER_BLOCK_NAME,
  transcriptDateHeader,
  TRIGGER_NOT_IN_TRANSCRIPT_LABEL,
} from "../../../consts/aiChat/prompts/transcript";
import { truncateInline } from "../../../libs/text";

/**
 * 发言人的显示名：first/last 拼接，都没有则给个占位。
 *
 * 这是转录热函数：每条转录行、回复标注和回复链节点都会调用。直接分支拼接，
 * 不创建临时数组或过滤结果；全空白字段与两者皆空时回退到占位符。
 */
function displaySpeakerName(speaker: AiSpeakerSnapshot): string {
  const first: string = speaker.firstName;
  const last: string = speaker.lastName;
  if (first && last) return `${first} ${last}`.trim() || FALLBACK_SPEAKER_NAME;
  // `|| ""` 不是多余的：外部输入若越过类型边界带来 undefined，必须安全退化
  // 成占位符；`(first || last).trim()` 会抛 TypeError。
  // 转录是回复链路的必经之地，不值得为省一次 `|| ""` 换一条可能抛异常的路径。
  return (first || last || "").trim() || FALLBACK_SPEAKER_NAME;
}

export function displayBufferedMessageName(message: BufferedMessage): string {
  return displaySpeakerName(message);
}

/**
 * 一个人的完整身份段：`[id:…] [username:@…] 显示名`，公开 username 缺席时省略
 * 中段。转录行、回复标注和回复链里的同一段身份是逐字同形的，因此提示词里点名
 * 某个人（目前是回复任务开头的唤起者声明，见 workers/aiChat/promptContext.ts）
 * 用这个函数生成，模型不必在两种身份写法之间二次对齐。
 *
 * 高频转录行与回复链继续内联拼接，避免先物化完整身份中间串；本函数每轮回复
 * 最多调用一次，形状一致由测试守住。
 */
export function formatSpeakerIdentity(speaker: AiSpeakerSnapshot): string {
  const usernameTag: string = speaker.username ? ` [username:@${speaker.username.replace(/^@+/, "")}]` : "";
  return `[id:${speaker.id}]${usernameTag} ${displaySpeakerName(speaker)}`;
}

/** 转发来源标注，明确正文并非发送者本人所写；模板与说明文案共用（见
 * consts/aiChat/prompts/transcript.ts）。 */
function formatForwardTag(forwardedFrom: string | undefined): string {
  return forwardedFrom ? forwardTagTemplate(forwardedFrom) : "";
}

/** 回复关系以内嵌元数据呈现，模型无需靠相邻消息猜测被回复对象。 */
function formatReplyReference(reference: BufferedReplyReference): string {
  const usernameTag: string = reference.username ? ` [username:@${reference.username.replace(/^@+/, "")}]` : "";
  const quote: string = reference.quote ? replyQuoteInlineTemplate(reference.quote) : "";
  return replyTagTemplate({
    target: `[message_id:${reference.messageId}] [id:${reference.id}]${usernameTag} ${displaySpeakerName(reference)}`,
    text: reference.text,
    forwardTag: formatForwardTag(reference.forwardedFrom),
    quote,
  });
}

/** formatReplyChain 的渲染上下文。 */
export interface ReplyChainOptions {
  /** 本轮转录的渲染结果：各跳身份取行内编号，触发消息还在不在转录里也看它。 */
  readonly rendered: RenderedTranscript;
  /** 触发消息不在渲染窗口里时改用的指代。默认只说「不在转录里」——那等于告诉
   *  模型「找不到」，调用方手上有正文时应当传入引述式指代，让两处引用互相指认
   *  （见 workers/aiChat/promptContext.ts 的 absentTriggerLabel）。 */
  readonly absentTriggerLabel?: string;
}

/**
 * 多层回复链标注：单跳回复标注只覆盖第一跳，链 ≥2 跳时在回复任务区块补
 * 全路径（见 workers/aiChat/promptContext.ts）。各跳身份与转发来源标记和
 * 转录行一致，正文按 REPLY_CHAIN_NODE_MAX_CHARS 截断。已滑出热区、仅靠
 * 上一跳回复快照保留的链尾显式标记；不足 2 跳时返回空串。
 */
export function formatReplyChain(
  triggerMessageId: number,
  chain: ReplyChainLink[],
  { rendered, absentTriggerLabel = TRIGGER_NOT_IN_TRANSCRIPT_LABEL }: ReplyChainOptions
): string {
  if (chain.length < 2) return "";
  const links: string[] = chain.map((link: ReplyChainLink): string => {
    const snapshotTag: string = link.snapshotOnly ? ` ${REPLY_CHAIN_SNAPSHOT_TAG}` : "";
    // 身份写法与转录行对齐：人在名册里就只写编号，模型顺着链回转录找那一行时
    // 不必在两种身份形态之间换算；链尾快照那种名册里没有的人才退回完整身份段。
    const speaker: string = rendered.codeOf.get(link.id) ?? formatSpeakerIdentity(link);
    return `${messageNumberTag(link.messageId)} ${speaker}${formatForwardTag(link.forwardedFrom)}${snapshotTag}：「${truncateInline(link.text, REPLY_CHAIN_NODE_MAX_CHARS)}」`;
  });
  // 触发消息本身已经滑出渲染窗口时写 #N，等于让模型去转录里搜一个不存在的编号。
  return replyChainTemplate(
    rendered.present.has(triggerMessageId) ? messageNumberTag(triggerMessageId) : absentTriggerLabel,
    links
  );
}

/**
 * 把一条缓存消息格式化成**自包含**的一行：时间、消息号、完整身份、转发来源和
 * 被回复原文全都内嵌，不依赖任何外部名册。
 *
 * 冷历史压缩由 workers/aiChat/compaction.ts 的 summarizeBatch 调用。
 * 那条路每 COMPACT_BATCH_SIZE 条消息才跑一次、单独一次模型调用、没有名册可查，
 * 自包含正是它需要的；说明文案见 consts/aiChat/prompts/memory.ts 的
 * SUMMARY_SYSTEM_PROMPT。回复转录使用名册 + 编号的紧凑渲染，见
 * buildTieredVerbatimTranscript。
 */
export function formatBufferedMessageLine(message: BufferedMessage): string {
  // message_id 段直接写进最终模板，不先物化 messageIdTag 中间串。usernameTag /
  // replyTag 仍留变量——它们是条件分支，
  // 内联成三元反而让这行长到读不动，且省不掉那次物化。
  const usernameTag: string = message.username ? ` [username:@${message.username.replace(/^@+/, "")}]` : "";
  const replyTag: string = message.replyTo ? formatReplyReference(message.replyTo) : "";
  return `[${message.at}] [message_id:${message.messageId}] [id:${message.id}]${usernameTag} ${displayBufferedMessageName(message)}${formatForwardTag(message.forwardedFrom)}${replyTag}：${message.text}`;
}

/** buildTieredVerbatimTranscript 的一次渲染状态：编号表 + 哪些行要带消息号。 */
interface TranscriptContext {
  /** 发送者 id → 行内编号；机器人自己固定是 SELF_ROSTER_CODE。
   *  单独一张只存编号的表，是因为它每渲染一行就要查一次（一次回复上百次），
   *  而下面那张快照表只在拼名册时遍历一遍。 */
  readonly speakers: Map<number, string>;
  /** 发送者 id → 窗口内**最后一次**出现时的身份快照，供名册取显示名与 username。
   *  取最后一次而不是第一次：改过名的人应当以现在的称呼登记，且与回复任务里
   *  唤起者声明的取法一致（见 workers/aiChat/promptContext.ts 的 resolveInvoker）。
   *  Map 的插入顺序不因覆盖而改变，所以名册顺序仍是「按首次发言先后」。 */
  readonly speakerSnapshots: Map<number, AiSpeakerSnapshot>;
  /** 转发来源原串 → 行内编号（f1、f2……）。 */
  readonly origins: Map<string, string>;
  /** 需要写出 #消息号 的消息：本段内被回复过的目标，加上本轮触发消息。 */
  readonly numbered: Set<number>;
  /** 本段内确实存在的消息号；决定回复标注走指针还是退回内嵌快照。 */
  readonly present: Set<number>;
  /** 入参里重复的 message_id 条数，由 `messages.length - present.size` 白拿——
   *  `present` 本来就要按全部消息建一遍，判重不额外走一趟。>0 时调用方去重后
   *  重建一次上下文（见 buildTieredVerbatimTranscript）。 */
  readonly duplicates: number;
}

/** renderRange 要渲染的半开区间 [start, end)。 */
interface TranscriptRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 渲染结果。除了拼好的文本，还把「行内编号」和「哪些消息号真的在转录里」交出来：
 * 转录之外还要点名某个人或某条消息的地方（唤起者声明、回复链、排队补跑的回复
 * 引用）因此能用与转录行同一套写法，模型不必在两种身份/消息号形态之间做连接，
 * 也不会被指向一个转录里根本不存在的编号。
 */
export interface RenderedTranscript {
  readonly text: string;
  /** 发送者 id → 行内编号（uN / me）。名册里没有的人查不到，由调用方退回完整身份段。 */
  readonly codeOf: ReadonlyMap<number, string>;
  /** 真正出现在渲染出来的转录里的 message_id。直接把内部那张表以只读形态交出去，
   *  不包一层 `has(id)` 闭包：那是每轮渲染都要新分配一个的一次性闭包，而调用方
   *  要的语义 `Set.has` 本来就有。 */
  readonly present: ReadonlySet<number>;
  /** 转录之外引用某条被回复消息时的紧凑写法：在窗口内就给指针，否则退回内嵌快照。 */
  readonly replyReference: (reference: BufferedReplyReference) => string;
}

export interface TieredTranscriptOptions {
  /** 机器人自己的账号 id：它在名册里固定拿 SELF_ROSTER_CODE。 */
  readonly selfId: number;
  /** 本轮触发消息的 message_id：回复任务里的多层回复链标注会点名它，
   *  因此即使没人回复过它也要保留消息号，否则那段标注指向一个转录里找不到的编号。 */
  readonly triggerMessageId: number;
}

/**
 * 扫一遍窗口，定下编号表与哪些行需要消息号。
 *
 * 一次回复只跑一遍（对比之下逐行渲染要跑一两百遍），因此这里按可读性写，
 * 不做 formatBufferedMessageLine 那种逐字节抠分配的处理。
 *
 * 转发来源只在**真的会被渲染出来**时才占编号：行自身的 forwardedFrom 一定会渲染，
 * 而被回复消息的 forwardedFrom 只在目标已滑出、退回内嵌快照时才出现——目标还在
 * 段内时那条转发标记根本不写，给它占个编号就等于在名册里挂一条没人引用的行。
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

  // 编号单独计数，不用 speakers.size 推：机器人占的是 SELF_ROSTER_CODE 而不是
  // 一个 uN，用 size 推会因为它在不在表里而错开一位。
  let userCode: number = 0;
  for (const message of messages) {
    if (!speakers.has(message.id)) {
      speakers.set(message.id, message.id === selfId ? SELF_ROSTER_CODE : `u${(userCode += 1)}`);
    }
    // 每条都覆盖，留下的是最后一次的身份；这里只存引用，身份串等到拼名册时
    // 按人各拼一次，不是按消息拼一百多次。
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
  return { speakers, speakerSnapshots, origins, numbered, present, duplicates: messages.length - present.size };
}

/** 名册区块：编号到人、编号到转发来源各一段；没有转发时后一段整个不出现。
 *  两段都直接遍历 buildTranscriptContext 攒好的表，不再回头重扫消息数组。 */
function buildRosterBlock(context: TranscriptContext): string {
  const speakerLines: string[] = [];
  for (const [id, snapshot] of context.speakerSnapshots) {
    speakerLines.push(rosterEntryTemplate(context.speakers.get(id)!, formatSpeakerIdentity(snapshot)));
  }
  const originLines: string[] = [];
  for (const [origin, code] of context.origins) originLines.push(rosterEntryTemplate(code, origin));

  return (
    `${SPEAKER_ROSTER_BLOCK_NAME}下面转录的每一行只写编号，编号对应的人看这里；「${SELF_ROSTER_CODE}」就是你自己：\n` +
    speakerLines.join("\n") +
    (originLines.length > 0
      ? `\n\n${FORWARD_ROSTER_BLOCK_NAME}行内「${forwardTagTemplate("f…")}」对应的原始来源看这里：\n` + originLines.join("\n")
      : "")
  );
}

/**
 * 把 [start, end) 区间渲染成紧凑行，日期变化时插一条日期分隔行。
 *
 * 区间开头一定先发一条日期分隔行（`lastDate` 传空串即可），这样每个分层区块
 * 都自带日期，模型跳进任一区块都不必回头找。
 *
 * 逐行 `+=` 累加，不创建行数组。生产会在拼进提示词、跨线程 clone 或发送网络时
 * 展平 rope；对应基准必须用 `charCodeAt(length - 1)` 强制物化，不能只读 `.length`，
 * 见 scripts/perf/hotPaths/transcriptScenarios.ts。
 *
 * `first` 用显式布尔而不是 `rendered === ""` 判空：后者把正确性绑在「任何一行都不会
 * 是空串」这个附带事实上，而布尔无条件成立。
 */
function renderRange(
  messages: BufferedMessage[],
  context: TranscriptContext,
  { start, end }: TranscriptRange
): string {
  let rendered: string = "";
  let first: boolean = true;
  let lastDate: string = "";
  for (let index: number = start; index < end; index += 1) {
    const message: BufferedMessage = messages[index]!;
    // `at` 由记录侧统一格式化成「YYYY/MM/DD HH:MM:SS」；万一没有空格就整串当
    // 时间用、不发日期行，宁可少一条分隔也不要把整段转录切坏。
    const at: string = message.at;
    const separator: number = at.indexOf(" ");
    // 同一天的行占绝大多数，先用定宽前缀比一次，把日期 slice 压到「真的换天」
    // 那几次；`indexOf`/`startsWith` 都不分配，省下的是每行一个中间串。
    //
    // 先比长度再比前缀，不能只用 `startsWith`：日期段一旦不是定宽（记录侧改成
    // 不补零就会变成 `2026/7/1`），`"2026/7/10 08:00:00".startsWith("2026/7/1")`
    // 为真，整个 7/10 会被静默归到 7/1 的表头下面。长度比较是 O(1)、不分配，
    // 却正好把这条路堵死。
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
      `[${clock}]${numberTag} ${context.speakers.get(message.id) ?? formatSpeakerIdentity(message)}${forwardTag}${formatCompactReplyTag(message.replyTo, context)}：${message.text}`;
    first = false;
  }
  return rendered;
}

/**
 * 紧凑回复标注。目标还在本段里就只留指针，作者与原文让模型顺编号回溯。
 *
 * 目标已滑出窗口时段内没有行可跳，退回内嵌快照；此时作者若仍在名册里就用编号，
 * 否则写完整身份。精确引用片段无论哪条路都保留：它是用户手选的片段，转录里
 * 没有任何别的地方记着它。
 */
function formatCompactReplyTag(
  reference: BufferedReplyReference | undefined,
  context: TranscriptContext
): string {
  if (reference === undefined) return "";
  // 引用片段的拼接留在「已滑出」那条分支里。放在这里的话，紧接着的快路径 return
  // 用的是 replyQuoteTemplate、根本不读它；目标仍在窗口内时不得白拼内嵌引用串。
  if (context.present.has(reference.messageId)) {
    return `${replyPointerTemplate(reference.messageId)}${reference.quote ? replyQuoteTemplate(reference.quote) : ""}`;
  }
  const identity: string = context.speakers.get(reference.id) ?? formatSpeakerIdentity(reference);
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
 * 记忆；更早、但仍未滑出逐字缓存的上一块列为次要背景。这样模型不会把
 * 压缩摘要、上一块逐字镜像和正在发生的对话等权看待。
 *
 * 行本身走紧凑渲染：身份、转发来源各出一次名册，行内只写编号；日期只在变化时
 * 单起一行；消息号只给真的会被引用的行；被回复消息只留指针。整段转录每次回复
 * 都要重发且无法跨回复缓存，因此重复结构必须保持紧凑。
 * 各项对「认人 / 回复回溯」的影响在 88 道客观题上与全量格式打平，见
 * test/aiChat/ai/chatTranscript.test.ts 钉住的形状。
 *
 * 本段只出数据和分层标注：行格式怎么读由 systemInstruction 里的
 * TRANSCRIPT_FORMAT_INSTRUCTION 交代（见 consts/aiChat/prompts/memory.ts）。
 * 那段说明恒定，拼在这里就会跟着每轮都变的转录一起落进缓存不到的那一半。
 */
export function buildTieredVerbatimTranscript(
  messages: BufferedMessage[],
  options: TieredTranscriptOptions
): RenderedTranscript {
  // 判重不额外扫一遍：上下文本来就要按全部消息建 `present`，重复几条由
  // 长度差白拿。真有重复才付去重与重建上下文的代价——那是重启撞上重投才有的
  // 罕见情形，不该让每一轮渲染都为它多走一趟。
  const scanned: TranscriptContext = buildTranscriptContext(messages, options);
  const deduped: BufferedMessage[] = scanned.duplicates === 0
    ? messages
    : dedupeByMessageId(messages, scanned.duplicates);
  const context: TranscriptContext = scanned.duplicates === 0
    ? scanned
    : buildTranscriptContext(deduped, options);
  const hotStart: number = Math.max(0, deduped.length - COMPACT_BATCH_SIZE);
  const text: string =
    buildRosterBlock(context) + "\n\n" +
    (hotStart > 0
      ? "【较早逐字记录（次要背景）】这些记录仍是原文，但判断当前话题和应答对象时应让位于下方最热记忆：\n" +
        renderRange(deduped, context, { start: 0, end: hotStart }) +
        "\n\n"
      : "") +
    `【最热记忆（重要判断标准，最新最多 ${COMPACT_BATCH_SIZE} 条）】这是滑动缓存里最新、最应优先关注的逐字消息。` +
    "判断当前话题、人物指代、@对象、情绪和该回应谁时，必须优先依据本段；最后一条是最新消息：\n" +
    renderRange(deduped, context, { start: hotStart, end: deduped.length });
  return {
    text,
    codeOf: context.speakers,
    present: context.present,
    replyReference: (reference: BufferedReplyReference): string => formatCompactReplyTag(reference, context),
  };
}

/**
 * 同一个 message_id 完全可能有两份条目同时在热区（快照 hydrate 出来一份，
 * Telegram 又重投了同一条 update 再记一份，见 workers/aiChat/replyChain.ts 的
 * 注释），而紧凑转录拿 #N 当指针——两行同号，指针就指不准了。
 *
 * 保留最后一份：媒体描述之类的回填只会落在后写入的那份上。只在 duplicates>0
 * 时才由调用方走这条路——判重本身是 buildTranscriptContext 顺手算出来的，
 * 每轮渲染不为这个罕见情形多扫一遍数组。
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
    "【冷记忆（长期背景）】下列内容是更早对话的压缩摘要（按时间从旧到新），只用于理解长期话题、称呼、人物关系和前因后果，不用于判断当前状态；" +
    "它与较新的逐字记录不一致时，只说明情况后来变了，当前状态以逐字记录为准：\n" +
    summaries.map((summary: string, index: number): string => `${index + 1}. ${summary}`).join("\n")
  );
}
