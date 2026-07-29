/**
 * 广告检测在主线程侧的那一半：投递与处置。判定本身（排队、送 DeepSeek、删消息、
 * 群内播报）全部在入群守卫线程执行，见 workers/antiRaid/adDetect/。
 *
 * 主线程只做两件事：
 * - 投递：每条群消息在入群守卫入口顺带判一次门禁（本群开了 /ad_detect enable、
 *   机器人是本群管理员、发送者不是自己人），通过就把清洗后的正文投给 Worker。
 *   投递走普通 post 而非 durable 边界——判定是尽力而为的启发式，丢一条待检
 *   消息不构成安全边界失守，不值得为它给每条群消息加一次跨线程屏障。
 * - 处置：Worker 判成广告后回投事件，这里执行与 /block 完全相同的那套动作
 *   ——写进永久黑名单并落盘，再为每个在管群登记一批封禁交回 Worker 执行。
 *   名单是主线程的同步安全边界、封禁批次要进 durable outbox，两者都不能挪到
 *   Worker 里去（见 docs/04-invariants.md）。
 */

import type { Message } from "@grammyjs/types";
import { adDetectConfigReadiness } from "../config/readiness";
import { logger } from "../infra/logger";
import { AD_DETECT_DEEPSEEK_API_KEY, PRIVILEGED_USERS_ID, SUPER_ADMIN_USER_ID } from "../infra/config";
import {
  blockUser,
  confirmBlocklistPersisted,
  dispatchBlockedRemovals,
  isUserBlocked,
  requestBlocklistResweep,
  trackBlockedRemoval,
} from "../infra/blocklist";
import { getAllChatStates, getChatState } from "../infra/storage/stateStore";
import { postDiskIODiagnostic } from "../infra/diskIO";
import { deleteMessageAfter, sendMessage } from "../infra/telegram/actions";
import { isBotOwnMessage } from "../infra/selfSentTracker";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../consts/telegram";
import { activeVerificationSnapshots } from "../cache/antiRaid/verificationMirror";
import { inFlightAdDisposals } from "../cache/antiRaid/adDisposal";
import { verificationKey } from "../libs/verificationKey";
import { sanitizeInline } from "../libs/text";
import { formatTokyoTime } from "../libs/time";
import { formatUserLabel } from "../users/userLabel";
import { visibleSenderChat } from "../users/visibleSender";
import {
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} from "../consts/antiRaid/adDetect";
import type { AdCandidateMessage, AdDetectedEvent, AdSampleContext } from "../types/antiRaid";
import type { RemoveBlockedMembersParams } from "../types/blocklist";
import type { AdSampleDiskMessage } from "../types/diskIO";
import type { FlushResult } from "../types/lifecycle";
import type { Chat, MessageEntity } from "@grammyjs/types";

/** 自己人永远不进判定，也永远不被处置——名单不可逆，见 docs/04-invariants.md。 */
function isProtectedSender(senderId: number): boolean {
  return senderId === SUPER_ADMIN_USER_ID || PRIVILEGED_USERS_ID.includes(senderId);
}

/**
 * 摘出 text_link 实体里的 URL，与正文分开随投递带给 Worker。
 *
 * 超链接的可见文字可以完全无害（「点这里」），落地页只在实体的 url 里，而
 * 「有没有把人带离本群的落点」是判定规则中最硬的一条——只读 message.text 的话，
 * 挂了链接的广告在模型眼里就是一句没有落点的正常话。裸链接不必管：那种 URL
 * 本来就在正文里，实体只是标出了偏移。
 *
 * **不能拼进正文再交给 Worker 截断**：Worker 按 AD_DETECT_MESSAGE_MAX_CHARS 从
 * 头部保留，拼在尾部的 URL 正好是超长时被切掉的那一段——七百字废话加一个锚文本
 * 为「点这里」的超链接就能让落地页永远到不了模型面前，而填充文本是零成本的。
 * 分开带的话，正文与 URL 各有各的配额（见 workers/antiRaid/adDetect/queue.ts）。
 *
 * 带出去的是消息自身携带的 URL、不带任何系统措辞，因此不会给正文引入可以被伪造
 * 的结构——发送者把「https://…」直接打进正文，得到的也是同样的文本。
 */
function collectHiddenLinkUrls(text: string, entities: readonly MessageEntity[] | undefined): string[] {
  if (entities === undefined) return [];
  const urls: string[] = [];
  for (const entity of entities) {
    if (urls.length >= AD_DETECT_MAX_LINK_URLS) break;
    if (entity.type !== "text_link") continue;
    const url: string = sanitizeInline(entity.url).slice(0, AD_DETECT_LINK_URL_MAX_CHARS);
    if (url.length === 0 || text.includes(url) || urls.includes(url)) continue;
    urls.push(url);
  }
  return urls;
}

/**
 * 摘出只给人看的上下文：这条消息引用了哪一段、回复了哪条消息的正文。
 *
 * **这两样绝不能进送检文本**——它们是别人的内容，并进判定就等于让引用广告来
 * 吐槽的群友替广告主背锅，而那条原消息在它自己发出时已经判过一次
 * （见 docs/04-invariants.md）。它们只随命中样本落盘：人回头翻样本、调
 * config/ad_samples.json 的口径时，「它当时在回谁、引了什么」往往正是判断
 * 这一条到底算不算误判的关键。因此单独一个字段，与 text 严格分开传。
 */
function buildSampleContext(message: Message): AdSampleContext | undefined {
  const quote: string = sanitizeInline(message.quote?.text ?? "").slice(0, AD_SAMPLE_CONTEXT_MAX_CHARS);
  const replied: Message | undefined = message.reply_to_message;
  const replyTo: string = sanitizeInline(replied?.text ?? replied?.caption ?? "").slice(0, AD_SAMPLE_CONTEXT_MAX_CHARS);
  if (quote.length === 0 && replyTo.length === 0) return undefined;
  return {
    ...(quote.length > 0 ? { quote } : {}),
    ...(replyTo.length > 0 ? { replyTo } : {}),
  };
}

/**
 * 把一条群消息收敛成待判定投递。返回 undefined 表示这条不参与广告检测：
 * 本群没开开关、没有可判定的正文、发送者是机器人自己或自己人，都在这里挡掉。
 *
 * 匿名管理员拿当前群当皮套时 sender_chat.id === chat.id：Telegram 不会暴露
 * 皮套底下是谁，处置只会尝试封掉整个群身份，因此和 /block 一样直接跳过。
 * @param botId 本机器人的用户 id；自己发的消息不参与判定。
 */
export function buildAdCandidate(message: Message, botId: number): AdCandidateMessage | undefined {
  const chatId: number | undefined = message.chat?.id;
  if (chatId === undefined || message.chat.type === "private") return undefined;
  // 前提不齐时整条流水线停摆，而不是让每条群消息都去 Worker 里换一次
  // 「DeepSeek 没配」的错误日志、或让判定线程读示例清单时当场抛出：
  // /ad_detect enable 已经拦在前面，这里兜的是「开关先前开着、之后密钥被从
  // .env 里撤掉或 config/ad_samples.json 被改坏」这条路径。readiness 的结论
  // 按进程缓存，因此这道门禁只是一次布尔比较，不会每条消息读一次盘。
  if (AD_DETECT_DEEPSEEK_API_KEY === undefined) return undefined;
  if (!adDetectConfigReadiness().ok) return undefined;
  if (getChatState(chatId).isAdDetectEnabled !== true) return undefined;

  // 关联频道推到讨论组的自动转发不参与判定。那条消息的发送者是频道本身，
  // 处置会走 userId < 0 那条分支在每个托管群 banChatSenderChat，等于因为
  // 频道自己的一条推广贴把整个评论区连根拔掉；机器人发在频道里的帖子回弹
  // 进来时更是能把自己的频道拉黑。频道贴该不该发由频道管理员决定，不归
  // 讨论组的广告检测管。
  if (message.is_automatic_forward === true) return undefined;
  if (isBotOwnMessage(message)) return undefined;

  const senderChat: Chat | undefined = visibleSenderChat(message);
  const senderId: number | undefined = senderChat?.id ?? message.from?.id;
  if (senderId === undefined || senderId === botId) return undefined;
  if (senderChat?.id === chatId) return undefined;
  if (isProtectedSender(senderId)) return undefined;
  // 已经在黑名单里的人不必再判：处置早就排上了（秒踢、补扫或本次判定登记的
  // 封禁批次），此刻他还在说话只是因为封禁尚未落地。继续送检只会把额度烧在
  // 一个注定要被清出去的人身上，还会换来一次与上一次完全相同的处置。
  //
  // **但频道马甲不能在这里吞掉**：真人的封禁走 banChatMember，带
  // revoke_messages，落地时会把这段空档里的消息一起撤掉；频道身份走
  // banChatSenderChat，那个接口没有 revoke_messages，它抢发的每一条都没有任何
  // 清理路径。这些照常投给判定线程——那边的投递闸认得 blocked，会直接删掉而
  // 不进判定额度（见 states/adDetectAdmission.ts 的 admitAdCandidate）。
  const blocked: boolean = isUserBlocked(senderId);
  if (blocked && senderChat === undefined) return undefined;

  // 图片/视频只看说明文字：广告图本身的识别是另一套流水线，这里不因为拿不到
  // 正文就把整条消息当成空判定。
  const text: string = sanitizeInline(message.text ?? message.caption ?? "");
  const linkUrls: string[] = collectHiddenLinkUrls(text, message.entities ?? message.caption_entities);
  if (text.length === 0 && linkUrls.length === 0) return undefined;
  const sampleContext: AdSampleContext | undefined = buildSampleContext(message);

  const label: string = senderChat === undefined
    ? formatUserLabel({
      id: senderId,
      username: message.from?.username,
      first_name: message.from?.first_name,
    })
    : formatUserLabel({
      id: senderId,
      username: "username" in senderChat ? senderChat.username : undefined,
      title: "title" in senderChat ? senderChat.title : undefined,
      isChannel: true,
    });

  return {
    type: "adCandidate",
    chatId,
    senderId,
    messageId: message.message_id,
    text,
    linkUrls,
    ...(sampleContext ? { sampleContext } : {}),
    label,
    isChannel: senderChat !== undefined,
    blocked,
    // 「刚进群还没通过验证」是模型自己看不到的事实：群聊转录里没有入群时间，
    // 让它去推只会推出一个编造的理由。待验证镜像正好是主线程的同步状态，
    // 顺手取一次即可；频道马甲不走入群验证，这里恒为 false。
    justJoined: activeVerificationSnapshots.has(verificationKey(chatId, senderId)),
  };
}

/** 处置目标所在的群清单：机器人已初始化且是管理员的群，同 /block 的连坐范围。 */
function managedChatIds(originChatId: number): number[] {
  const chatIds: number[] = [];
  for (const [chatId, chatState] of getAllChatStates()) {
    if (chatState.botIsAdmin !== true || chatState.isInitEnabled !== true) continue;
    chatIds.push(chatId);
  }
  // 判定发生的这个群排最前：那里正躺着刚发出来的广告，最该先封。
  return chatIds.includes(originChatId)
    ? [originChatId, ...chatIds.filter((chatId: number): boolean => chatId !== originChatId)]
    : chatIds;
}

/**
 * 把这次命中的原始素材投给落盘线程（memory/ad-detected/sample.json）。
 *
 * 纯旁路：进程从不读回它，丢了也不影响任何行为，因此不等落盘确认、不进统一
 * flush、投递失败只记一行日志。投递走 postDiskIODiagnostic：postDiskIO 在
 * Worker 恢复窗口里会占那份触顶即致命停机的重放缓冲，而这条样本体积最大、
 * 命中时最密集，不该拿一个纯诊断把进程送走（见 infra/diskIO.ts）。
 * 它存在的唯一目的是让人回头翻原文，据此调
 * config/ad_samples.json 的判定口径——判定规则由提示词定死，题材口径全靠那份
 * 示例，而示例只能从真实命中里攒（见 consts/antiRaid/adDetect.ts）。
 *
 * 排在 blockUser 之前：这一步是同步记账，而下面几步要等落盘与投递屏障，中途
 * 任何一步抛错都会让这条素材连同事件一起消失——而它恰恰是「这次判得对不对」
 * 的唯一证据。误判时尤其如此：人得先看到原文才知道该往示例里加什么、减什么。
 */
function recordAdSample(event: AdDetectedEvent): void {
  if (event.messages.length === 0) return;
  const posted: boolean = postDiskIODiagnostic({
    type: "adSample",
    chatId: event.chatId,
    senderId: event.senderId,
    label: event.label,
    detectedAt: formatTokyoTime(Date.now()),
    reason: event.reason,
    messages: event.messages,
  } satisfies AdSampleDiskMessage);
  if (!posted) {
    logger.error(`Failed to queue the ad detection sample for sender ${event.senderId} in chat ${event.chatId}.`);
  }
}

/**
 * 执行一次判定命中的处置：先写名单再落盘，然后为每个在管群登记一批封禁并交回
 * Worker。顺序与 /block 一致——名单覆盖的是「以后」，封禁只覆盖此刻已知且有
 * 管理权的群，两者不能互相替代。
 *
 * 重复命中同一个人时只补这个群一批封禁，不再重走整套。判定是自动触发的，同一
 * 个刷屏号在封禁落地之前完全可能被再判一次（Worker 侧另有一层窗口内抑制，但
 * 跨窗口拦不住），而整套处置的代价是「一次带 fsync 的黑名单落盘 + 每个在管群
 * 各一批封禁，每批都要整份 outbox 深拷贝并落盘」——按群数放大的 O(n²) 写盘，
 * 正是 docs/04-invariants.md 点名要避开的形态。名单条目在第一次命中时就已写进
 * 内存 Map 并投过落盘（那一次若没写成，日志里已经点名，且 Disk I/O Worker 重建
 * 会重放本进程新增的条目），其余群的封禁批次也还在 outbox 里等重试；重来一遍
 * 换不到任何新东西。这与 `/block` 的重试语义不冲突：那条路的重复调用是管理员
 * 修好磁盘后的人为重试，这条路是刷屏号自己触发的，两者不该共用一套代价。
 */
async function disposeDetectedAd(event: AdDetectedEvent): Promise<void> {
  if (isProtectedSender(event.senderId)) {
    logger.error(
      `Ad detection flagged privileged sender ${event.senderId} in chat ${event.chatId}; ignoring the verdict.`
    );
    return;
  }
  recordAdSample(event);
  const newlyBlocked: boolean = blockUser(event.senderId);
  if (newlyBlocked && !await confirmBlocklistPersisted()) {
    logger.error(
      `Ad detection blocklist entry for sender ${event.senderId} is memory-only; ` +
      "it will be lost on restart."
    );
  }

  // 重复命中只补触发群这一批，且照样过 managedChatIds 那道过滤：两次命中之间
  // 机器人可能刚被撤管理员或这个群刚 /init disable，那时连这一批也不该登记。
  const managed: number[] = managedChatIds(event.chatId);
  const enforcementChatIds: number[] = newlyBlocked
    ? managed
    : managed.filter((chatId: number): boolean => chatId === event.chatId);
  // 逐个群登记，失败只作废这一个群。整段用 map 的话，trackBlockedRemoval 中途
  // 抛出（outbox 满、id 空间耗尽）会让已登记的几批留在 outbox 里而
  // dispatchBlockedRemovals 一次都调不到，这人在**所有**群都封不掉。降级语义同
  // blocklistGuard.claimBlockedJoiner，失败的群改由补扫接手。
  const removals: RemoveBlockedMembersParams[] = [];
  let failedChats: number = 0;
  for (const chatId of enforcementChatIds) {
    try {
      removals.push(trackBlockedRemoval({
        chatId,
        userIds: [event.senderId],
        // 探测省不掉一次网络往返却救不了什么：目标此刻多半就在群里，而封禁本身
        // 对不在群的人也是幂等的（同秒踢那一路）。
        probeMembership: false,
      }));
    } catch (error: unknown) {
      failedChats++;
      logger.error(
        `Failed to queue the ad removal of sender ${event.senderId} in chat ${chatId}:`,
        error
      );
      requestBlocklistResweep(chatId);
    }
  }
  if (removals.length === 0) {
    logger.error(
      `Ad detection has no chat to enforce the block of sender ${event.senderId} in ` +
      `(${failedChats} chat(s) failed to queue); the blocklist entry still applies to future joins.`
    );
    await announceAdDisposal(event, 0);
    return;
  }
  if (failedChats > 0) {
    logger.error(
      `Ad detection could not queue the removal of sender ${event.senderId} in ${failedChats} chat(s); ` +
      "those chats now owe a resweep."
    );
  }
  await dispatchBlockedRemovals(removals);
  logger.log(
    `Ad detection blocked sender ${event.senderId} (${event.reason || "no reason given"}) ` +
    `and queued removals in ${removals.length} chat(s).`
  );
  await announceAdDisposal(event, removals.length);
}

/**
 * 群内播报：只带展示标签与判定理由，不回显广告原文（回显等于替广告再发一遍）。
 * 模型没给理由时用兜底文案——这条消息存在的意义就是说清「为什么这个人没了」，
 * 不能空着。导出仅为可测试性。
 *
 * 文案按**真正登记上的封禁群数**分岔。一个群都没登记上时（outbox 触顶、刚被
 * 撤管理员、`/init disable`）人根本没被踢走，这时再说「在所有盯着的群里一起
 * 封掉了」就是一条与事实相反的公告；那种情况改成点名请管理员介入。
 */
export function formatAdNotice(label: string, reason: string, enforcedChats: number): string {
  const head: string = `哼，${label} 被本天才当广告封了，理由：${reason || "整串消息通篇都是推广引流"}。`;
  return enforcedChats === 0
    ? `${head}这些消息已经删干净，人也记进小本本了；可本天才现在一个群都封不动，杂鱼管理员快来看看本天才的权限♡`
    : `${head}这些消息已经删干净，人也记进小本本、在所有盯着的群里一起封掉了♡`;
}

/**
 * 发播报并挂上自动清理。播报本身 KICK_NOTICE_AUTO_DELETE_MS（30 秒）后自删，
 * 与超时踢人的战报同一条约定，不给群里留一条永久的公告。
 *
 * 发在主线程而不是判定线程：文案要断言封禁结果，而结果只有这边知道（理由见
 * workers/antiRaid/adDetect/disposal.ts 的 disposeAdSender）。整段尽力而为，
 * 失败不影响已经落定的拉黑与封禁登记。
 */
async function announceAdDisposal(event: AdDetectedEvent, enforcedChats: number): Promise<void> {
  const noticeMessageId: number | undefined = await sendMessage({
    chatId: event.chatId,
    text: formatAdNotice(event.label, event.reason, enforcedChats),
  });
  if (noticeMessageId === undefined) return;
  deleteMessageAfter({
    chatId: event.chatId,
    messageId: noticeMessageId,
    delayMs: KICK_NOTICE_AUTO_DELETE_MS,
  });
}

/**
 * Worker 回投的判定命中：登记成在途处置任务。事件回调是同步的，而处置要等
 * 落盘与投递屏障，因此挂进 cache/antiRaid/adDisposal.ts 的集合里，由停机 drain
 * 统一等待，不让它在半路被丢掉。
 */
export function handleAdDetected(event: AdDetectedEvent): void {
  const task: Promise<void> = disposeDetectedAd(event)
    .catch((error: unknown): void => {
      // 名单与 outbox 都已经 durable，失败的只是这一次投递；重启恢复与下一次
      // 管理员身份观测触发的补扫都会把它接上。
      logger.error(`Failed to dispose the ad verdict for sender ${event.senderId}:`, error);
    })
    .finally((): void => {
      inFlightAdDisposals.delete(task);
    });
  inFlightAdDisposals.add(task);
}

/**
 * 等这一批在途处置结算，超时返回 false。计时器 unref：处置提前结算时不该让
 * 一个还没到点的 timer 把进程按在事件循环里——停机路径上那段等待是纯浪费。
 */
function waitForDisposals(tasks: readonly Promise<void>[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve: (settled: boolean) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => resolve(false), timeoutMs);
    timer.unref();
    void Promise.allSettled(tasks).then((): void => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * 停机排空：在预算内等待所有在途处置结算（含结算过程中新派生的）。
 *
 * 预算不能省。处置内部要走 confirmBlocklistPersisted（一次带 fsync 的领域 flush）
 * 与 dispatchBlockedRemovals（outbox 写前落盘 + mailbox 屏障），裸等的话，异常
 * 退出那条把全部预算设成 0 的路径（FATAL_FLUSH_TIMEOUTS，见
 * docs/04-invariants.md）本该立刻结算成 timedOut，实际会一路拖到 15 秒强制退出
 * ——进程带非零码死在停机中途，实例锁不释放、offset 不确认。
 * @returns 全部结算为 flushed；预算用尽仍有在途为 timedOut。
 */
export async function drainAdDisposals(timeoutMs: number): Promise<FlushResult> {
  const deadline: number = Date.now() + timeoutMs;
  while (inFlightAdDisposals.size > 0) {
    const remaining: number = Math.max(0, deadline - Date.now());
    if (remaining === 0 || !await waitForDisposals([...inFlightAdDisposals], remaining)) {
      logger.error(
        `Ad disposal drain timed out with ${inFlightAdDisposals.size} task(s) still in flight; ` +
        "the blocklist entries and removal batches stay in their durable outbox."
      );
      return "timedOut";
    }
  }
  return "flushed";
}
