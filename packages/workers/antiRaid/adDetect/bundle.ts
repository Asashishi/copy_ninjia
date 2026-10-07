/**
 * 单个发送者那一串待检消息（AdMessageBundle）的整形：裁剪、收容量、拼正文。
 *
 * queue.ts 管的是「谁排在队里、什么时候起判定」，这里管的是「这一串里到底留
 * 哪几条、送检时长什么样」。前者围绕三张所有权表的同步增删（见 states/adDetectAdmission.ts），
 * 后者围绕「未判定的内容不能悄悄消失」。
 *
 * 贯穿本文件的规矩：**能挤掉的只有已经判过的条目**（seq <= checkedSeq）。
 * 真到了只剩没判过的可丢时，正文不再留，但消息身份必须转进 pendingDeleteIds，
 * 使这条广告仍能进入处置的删除集合。
 */

import { logger } from "../../../infra/logger";
import { sanitizeInline } from "../../../libs/text";
import {
  AD_DETECT_BUNDLE_MAX_CHARS,
  AD_DETECT_JUDGED_RETENTION_WINDOW_MS,
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_DETECT_MAX_MESSAGES_PER_SENDER,
  AD_DETECT_MAX_PENDING_DELETE_IDS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} from "../../../consts/antiRaid/adDetect";
import type {
  AdBundleSelection,
  AdCandidateEntry,
  AdMessageBundle,
  AdSampleContext,
} from "../../../types/antiRaid/adDetect";

/**
 * 裁掉保留窗口外、并且已经判过的旧上下文。尚未判定的条目即使等待超过一个
 * 窗口也必须留到消费；entries 按序号与时间入队，碰到未消费或仍在窗口内的
 * 第一条就可以停。
 */
export function pruneConsumedContext(bundle: AdMessageBundle, now: number): void {
  while (bundle.entries.length > 0) {
    const oldest: AdCandidateEntry | undefined = bundle.entries[0];
    if (
      oldest === undefined ||
      oldest.seq > bundle.checkedSeq ||
      now - oldest.receivedAt < AD_DETECT_JUDGED_RETENTION_WINDOW_MS
    ) break;
    bundle.entries.shift();
  }
}

/**
 * 把消息串收进单 key 条数上限。
 *
 * 先挤已经判过的旧上下文（同 pruneConsumedContext 的规矩，按条数而非按窗口）。
 * 整串都还没判过时只剩没判过的可丢：正文不再留，身份转进 pendingDeleteIds。
 */
export function enforceBundleCapacity(bundle: AdMessageBundle): void {
  while (
    bundle.entries.length > AD_DETECT_MAX_MESSAGES_PER_SENDER &&
    (bundle.entries[0]?.seq ?? Number.POSITIVE_INFINITY) <= bundle.checkedSeq
  ) {
    bundle.entries.shift();
  }
  while (bundle.entries.length > AD_DETECT_MAX_MESSAGES_PER_SENDER) {
    const evicted: AdCandidateEntry = bundle.entries.shift()!;
    // 每个发送者只记一次日志。
    if (!bundle.uncheckedEvicted) {
      bundle.uncheckedEvicted = true;
      logger.error(
        `Ad detection dropped never-judged message text from sender ${bundle.senderId} in chat ` +
        `${bundle.chatId}: the burst filled the ${AD_DETECT_MAX_MESSAGES_PER_SENDER}-message ` +
        "per-sender limit before the first tick, so that content never reaches the classifier."
      );
    }
    if (bundle.pendingDeleteIds.length >= AD_DETECT_MAX_PENDING_DELETE_IDS) {
      // 每个发送者只记一次日志。
      if (!bundle.pendingDeleteOverflowed) {
        bundle.pendingDeleteOverflowed = true;
        logger.error(
          `Ad detection filled the ${AD_DETECT_MAX_PENDING_DELETE_IDS}-id pending-delete list of ` +
          `sender ${bundle.senderId} in chat ${bundle.chatId}; the oldest ad messages will stay in ` +
          "the chat even if the sender is flagged."
        );
      }
      bundle.pendingDeleteIds.shift();
    }
    bundle.pendingDeleteIds.push(evicted.messageId);
  }
}

/** 这一串里最新一条消息的序号；空串返回 0（= 没有任何待判定内容）。 */
export function latestSeq(bundle: AdMessageBundle): number {
  return bundle.entries[bundle.entries.length - 1]?.seq ?? 0;
}

/**
 * 把隐藏的落地页 URL 接到已截断的正文后面。
 *
 * URL 段有自己的配额（AD_DETECT_MAX_LINK_URLS、AD_DETECT_LINK_URL_MAX_CHARS），接在
 * 已按 AD_DETECT_MESSAGE_MAX_CHARS 截断的正文之后，不占正文额度。上限在 Worker 侧
 * 再收一次，不依赖主线程的形状保证。
 */
export function appendLinkUrls(
  text: string,
  linkUrls: readonly string[] | undefined
): string {
  if (linkUrls === undefined || linkUrls.length === 0) return text;
  const urls: string[] = [];
  for (const raw of linkUrls) {
    if (urls.length >= AD_DETECT_MAX_LINK_URLS) break;
    const url: string = sanitizeInline(raw).slice(0, AD_DETECT_LINK_URL_MAX_CHARS);
    if (url.length === 0 || text.includes(url) || urls.includes(url)) continue;
    urls.push(url);
  }
  if (urls.length === 0) return text;
  return text.length === 0 ? urls.join(" ") : `${text} ${urls.join(" ")}`;
}

/**
 * 串里是否已经有条目带着这段引文。
 *
 * 具名 for-of 实现，不创建捕获 needle 的一次性闭包；每条带引用/回复的候选消息执行两遍。
 */
function entriesClaimContextPart(
  entries: readonly AdCandidateEntry[],
  needle: string
): boolean {
  for (const entry of entries) {
    if (entry.text.includes(needle)) return true;
  }
  return false;
}

/**
 * 把被引用段与被回复原文接到已截断的正文后面，一并交给模型判定。
 *
 * **这两样是「别人的内容」，但参与判定**：广告正文可能只活在被引用段和被回复原文中
 * （先发正常消息，编辑成广告后再用回复/引用顶上来）。
 *
 * 引用内容仍会让整串命中，但命中不等于立即 block：主线程已排除白名单来源，
 * Worker 再用 directText 做归因；发送者本人姓名或正文是广告时直接 block，广告只
 * 来自非白名单回复、引用或转发时先公开警告，警告窗口
 * （AD_REFERENCE_WARNING_WINDOW_MS）内再次命中才升级。
 *
 * 接法与 appendLinkUrls 一致：
 * - **接在截断之后、各有各的配额**（AD_SAMPLE_CONTEXT_MAX_CHARS）。
 * - **不带任何系统措辞**（不写「引用：」这类前缀），不给正文引入可被伪造的结构。
 *
 * 与正文重复的段落跳过；quote 与 replyTo 重合时只接一份。
 * context 来自 boundSampleContext，上限已在入队时由本侧收过一次，这里直接使用。
 *
 * **去重跨整串计算**（entries 为此传入）：同一段引文在整串里只留最早那一份，
 * 后来的消息照常凭自己的正文入选，读到的仍是同一份完整引文。
 *
 * 一条消息自己没有正文、引文又已被串里更早那条认领时，textLength 为 0，投递闸
 * （states/adDetectAdmission.ts 的 admitAdCandidate）按「没有可判定内容」忽略它；
 * 认领它的那条消息会替它把人送进处置。
 */
export function claimSampleContextParts(
  text: string,
  context: AdSampleContext,
  entries: readonly AdCandidateEntry[]
): string {
  let quote: string = context.quote ?? "";
  if (
    quote.length === 0 ||
    text.includes(quote) ||
    entriesClaimContextPart(entries, quote)
  ) {
    quote = "";
  }
  let replyTo: string = context.replyTo ?? "";
  if (
    replyTo.length === 0 ||
    text.includes(replyTo) ||
    replyTo === quote ||
    entriesClaimContextPart(entries, replyTo)
  ) {
    replyTo = "";
  }
  // 认领者被 enforceBundleCapacity 挤掉时这段引文随之从串里消失（见文件头）；
  // 之后回复原消息的候选会重新认领。
  if (quote.length === 0) {
    if (replyTo.length === 0) return text;
    return text.length === 0 ? replyTo : `${text} ${replyTo}`;
  }
  if (replyTo.length === 0) {
    return text.length === 0 ? quote : `${text} ${quote}`;
  }
  return text.length === 0
    ? `${quote} ${replyTo}`
    : `${text} ${quote} ${replyTo}`;
}

/**
 * 把候选平铺的两段样本上下文（AdCandidateMessage 的 sampleQuote、sampleReplyTo）收成
 * AdSampleContext，并在 Worker 侧再收一次长度，同 appendLinkUrls。两段文本已由唯一的
 * 生产者（antiRaid/adCandidate.ts）清洗成单行，这里只收长度。
 *
 * 判定文本那一份由 claimSampleContextParts 另行接进 text；这里保留的独立字段只
 * 服务命中样本，**不跨条去重**：样本侧每条都如实记下它当时引的是什么。
 */
export function boundSampleContext(
  rawQuote: string | undefined,
  rawReplyTo: string | undefined
): AdSampleContext | undefined {
  if (rawQuote === undefined && rawReplyTo === undefined) return undefined;
  const quote: string = (rawQuote ?? "").slice(0, AD_SAMPLE_CONTEXT_MAX_CHARS);
  const replyTo: string = (rawReplyTo ?? "").slice(0, AD_SAMPLE_CONTEXT_MAX_CHARS);
  if (quote.length === 0 && replyTo.length === 0) return undefined;
  if (quote.length === 0) return { replyTo };
  if (replyTo.length === 0) return { quote };
  return { quote, replyTo };
}

/**
 * 选出本次送检的条目，并给出这一拍真正判到了哪里。
 *
 * **未判定的内容一律从最旧一条开始装**，装不下的留到下一次判定（当前批结算后
 * 由 requeueIfUnchecked 立即重排）。checkedSeq 是「≤ 它的都判过了」的单调水位，
 * 只有按序判定才表达得出来，被预算挡在外面的旧消息不得落在水位之下。
 *
 * 预算有剩余时再从紧挨着的已判上下文往回补；补进来的上下文不影响水位。
 *
 * 命中样本只记录本函数选出的消息，与模型实际输入一致。
 */
export function selectAdBundleEntries(bundle: AdMessageBundle): AdBundleSelection {
  let budget: number = AD_DETECT_BUNDLE_MAX_CHARS;
  let checkedToSeq: number = bundle.checkedSeq;
  const pending: AdCandidateEntry[] = [];
  // 序号单调递增且只在尾部追加，已判条目必然是一段前缀；第一条未判的位置就是
  // 上下文与待判内容的分界。
  let firstPendingIndex: number = bundle.entries.length;
  for (let index: number = 0; index < bundle.entries.length; index++) {
    const entry: AdCandidateEntry | undefined = bundle.entries[index];
    if (entry === undefined || entry.seq <= bundle.checkedSeq) continue;
    if (firstPendingIndex === bundle.entries.length) firstPendingIndex = index;
    // 第一条无条件装下，使水位每次判定至少前进一条。
    if (entry.text.length > budget && pending.length > 0) break;
    budget -= entry.text.length;
    pending.push(entry);
    checkedToSeq = entry.seq;
  }
  const context: AdCandidateEntry[] = [];
  for (let index: number = firstPendingIndex - 1; index >= 0; index--) {
    const entry: AdCandidateEntry | undefined = bundle.entries[index];
    if (entry === undefined) continue;
    if (entry.text.length > budget) break;
    budget -= entry.text.length;
    context.push(entry);
  }
  context.reverse();
  // 复用 context 承载最终清单：reverse 之后它是清单的前半段（补回来的已判上下文），
  // 再追加 pending。
  for (const entry of pending) context.push(entry);
  return { entries: context, checkedToSeq };
}

/**
 * 把已经选好的一串消息拼成模型可读的编号清单，见 selectAdBundleEntries。
 * 只负责拼，不再筛选：判定读到的与水位推进依据的是同一份清单。
 */
export function formatAdBundleText(entries: readonly AdCandidateEntry[]): string {
  return entries
    .map((entry: AdCandidateEntry, index: number): string => `${index + 1}. ${entry.text}`)
    .join("\n");
}

/**
 * 拼出只含当前发送者本人姓名与正文的清单；空行跳过后重新连续编号。
 */
export function formatDirectAdBundleText(entries: readonly AdCandidateEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.directText.length === 0) continue;
    lines.push(`${lines.length + 1}. ${entry.directText}`);
  }
  return lines.join("\n");
}

/** 是否有引用、回复或转发内容实际进入了本次模型清单。 */
export function containsReferencedAdContent(entries: readonly AdCandidateEntry[]): boolean {
  for (const entry of entries) {
    if (entry.text !== entry.directText) return true;
  }
  return false;
}
