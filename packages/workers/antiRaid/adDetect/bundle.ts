/**
 * 单个发送者那一串待检消息（AdMessageBundle）的整形：裁剪、收容量、拼正文。
 *
 * 从 queue.ts 里分出来的一层——那边管的是「谁排在队里、什么时候起判定」，
 * 这里管的是「这一串里到底留哪几条、送检时长什么样」。两件事的不变量完全
 * 不同：前者围绕三张所有权表的同步增删（见 states/adDetectAdmission.ts），
 * 后者围绕「未判定的内容一条都不能悄悄消失」。
 *
 * 贯穿本文件的那条规矩：**能挤掉的只有已经判过的条目**（seq <= checkedSeq）。
 * 没判过的内容被裁掉就等于一次没有任何日志痕迹的漏判；真到了只剩没判过的
 * 可丢时，正文不再留，但消息 id 必须转进 pendingDeleteIds，否则这条广告既
 * 进不了判定、也进不了处置的删除集合，命中后会永久留在群里。
 */

import { logger } from "../../../infra/logger";
import { sanitizeInline } from "../../../libs/text";
import {
  AD_DETECT_BUNDLE_MAX_CHARS,
  AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS,
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_DETECT_MAX_MESSAGES_PER_SENDER,
  AD_DETECT_MAX_PENDING_DELETE_IDS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} from "../../../consts/antiRaid/adDetect";
import type { AdSampleContext } from "../../../types/antiRaid";
import type { AdCandidateEntry, AdMessageBundle } from "../../../types/antiRaid/adDetect";

/**
 * 裁掉去重窗口外、并且已经判过的旧上下文。尚未判定的条目即使等待超过一个
 * 窗口也必须留到消费；entries 按序号与时间入队，碰到未消费或仍在窗口内的
 * 第一条就可以停。
 */
export function pruneConsumedContext(bundle: AdMessageBundle, now: number): void {
  while (bundle.entries.length > 0) {
    const oldest: AdCandidateEntry | undefined = bundle.entries[0];
    if (
      oldest === undefined ||
      oldest.seq > bundle.checkedSeq ||
      now - oldest.receivedAt < AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS
    ) break;
    bundle.entries.shift();
  }
}

/**
 * 把消息串收进单 key 条数上限。
 *
 * 先挤已经判过的旧上下文——同 pruneConsumedContext 的规矩，只不过这里是按条数
 * 而不是按窗口。整串都还没判过时（爆发式刷屏能在第一个节拍到来之前就撑满）
 * 只剩没判过的可丢：正文不再留，但 id 转进 pendingDeleteIds，否则这条广告
 * 既不会被判定读到、也不会进处置的删除集合，会永久留在群里。
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
    if (bundle.pendingDeleteIds.length >= AD_DETECT_MAX_PENDING_DELETE_IDS) {
      // 每个发送者只记一次：溢出之后每条新消息都会再挤掉一个，逐条记等于刷屏。
      if (bundle.pendingDeleteOverflowed !== true) {
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
 * URL 段有自己的配额、不占正文的 AD_DETECT_MESSAGE_MAX_CHARS：正文截断从头部
 * 保留，先拼后截就等于给了发送者一个零成本绕过手段——七百字废话把 URL 顶出
 * 额度，「有没有把人带离本群的落点」这条最硬的规则当场失效。上限在这里再收一
 * 次而不是只信主线程：跨线程消息的形状由本函数所在的这一侧兜底。
 */
export function appendLinkUrls(text: string, linkUrls: readonly string[]): string {
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
 * 在 Worker 侧再收一次样本上下文的长度，理由同 appendLinkUrls：跨线程消息的
 * 形状由本侧兜底。原样展开的话这两个字段是整条流水线上唯一没有 Worker 侧上界
 * 的部分，而它们跟着每条 entry 常驻内存，条数按待检表容量放大。
 */
export function boundSampleContext(context: AdSampleContext | undefined): AdSampleContext {
  if (context === undefined) return {};
  const quote: string = sanitizeInline(context.quote ?? "").slice(0, AD_SAMPLE_CONTEXT_MAX_CHARS);
  const replyTo: string = sanitizeInline(context.replyTo ?? "").slice(0, AD_SAMPLE_CONTEXT_MAX_CHARS);
  return {
    ...(quote.length > 0 ? { quote } : {}),
    ...(replyTo.length > 0 ? { replyTo } : {}),
  };
}

/** 一次送检的取舍结果。 */
export interface AdBundleSelection {
  /** 本次真正交给模型的条目，按时间先后排列（已判上下文在前，未判内容在后）。 */
  entries: AdCandidateEntry[];
  /** 本次判到的最新未判条目序号；整串都已判过时等于 bundle.checkedSeq。 */
  checkedToSeq: number;
}

/**
 * 选出本次送检的条目，并给出这一拍真正判到了哪里。
 *
 * **未判定的内容一律从最旧一条开始装**，装不下的留到下一次判定（
 * requeueIfUnchecked → 去重窗口轮换）。这个顺序不是偏好而是正确性要求：
 * checkedSeq 是「≤ 它的都判过了」的单调水位，只有按序判定才表达得出来。
 * 反过来从最新一条往回取的话，被预算挡在外面的旧消息会夹在水位下面，跟着
 * 水位一起被记成「判过」再被 pruneConsumedContext 裁掉——一次没有任何日志
 * 痕迹的漏判，正是本文件头那条规矩要禁的。
 *
 * 预算有剩余时再从紧挨着的已判上下文往回补：拆开发的「加我 / 微信 / xxx」
 * 要合起来才判得出来。补进来的上下文不影响水位，它们本来就已经判过。
 *
 * 单独拆出来还因为**命中样本要记的正是这一份**：没入选的消息模型根本没读过。
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
    // 第一条无条件装下：单条正文有 AD_DETECT_MESSAGE_MAX_CHARS 上界、装不满预算，
    // 但真出现装不下的一条时空转会让这个 key 卡在「判不动又推不进水位」的死循环里。
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
  return { entries: [...context, ...pending], checkedToSeq };
}

/**
 * 把已经选好的一串消息拼成模型可读的编号清单，取舍见 selectAdBundleEntries。
 * 这里只负责拼，不再自己筛：判定读到的与水位推进依据的必须是同一份清单。
 */
export function formatAdBundleText(entries: readonly AdCandidateEntry[]): string {
  return entries
    .map((entry: AdCandidateEntry, index: number): string => `${index + 1}. ${entry.text}`)
    .join("\n");
}
