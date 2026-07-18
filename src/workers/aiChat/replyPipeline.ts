import { logger } from "../../infra/logger";
import { LinkedQueue } from "../../libs/linkedQueue";
import { truncateInline } from "../../libs/text";
import { displayBufferedMessageName } from "../../ai/utils/chatTranscript";
import {
  AI_TEXT_TYPO_PROBABILITY,
  QUEUED_TRIGGER_SNIPPET_MAX_CHARS,
  RATE_LIMIT_LONG_WINDOW_MS,
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
  RATE_LIMIT_NOTICE_TEXT,
  REPLY_ROUND_MAX_CONCURRENT,
} from "../../consts/aiChat";
import {
  activeReplyCounts,
  botInfoState,
  chatBuffers,
  longTriggerTimes,
  pendingOverflowNotices,
  pendingReplyTriggers,
  rateLimitNoticeTimes,
  replyGenerations,
} from "../../cache/aiChatWorker";
import { createReplyToolset } from "../../ai/tools/replyToolset";
import { startChatActionHeartbeat } from "../../ai/chatActionHeartbeat";
import { createStickerSendLock } from "../../ai/stickerSendLock";
import { sendMessage } from "../../infra/telegram";
import { SEND_MESSAGE_TOOL } from "../../consts/tools";
import type {
  AiBotInfo,
  AiSentMessage,
  BufferedMessage,
  QueuedReplyTrigger,
  ReplyToolContext,
  ReplyToolset,
  StickerSendLockControl,
} from "../../types";
import { buildUserContent, type MediaCommentContext } from "./promptContext";
import { callGemini } from "./geminiReply";
import { recordChatMessage } from "./rollingMemory";
import { resolvedTagFor } from "./mediaText";
import { admitRound, admitTrigger, type AdmitDecision, type TriggerKind } from "../../states/replyAdmission";

declare var self: Worker;

export function currentReplyGeneration(chatId: number): number {
  return replyGenerations.get(chatId) ?? 0;
}

export function isReplyGenerationCurrent(chatId: number, generation: number): boolean {
  return currentReplyGeneration(chatId) === generation;
}

export function invalidateChatReplies(chatId: number): void {
  replyGenerations.set(chatId, currentReplyGeneration(chatId) + 1);
  pendingReplyTriggers.delete(chatId);
  pendingOverflowNotices.delete(chatId);
}

/**
 * AI 回复的准入控制（并发闸 + 5 分钟滑动窗口限频 + 溢出排队补跑）与生成/
 * 发送编排。准入判定的纯规则收在 states/replyAdmission.ts（admitTrigger/
 * admitRound）；本文件是它的解释器——独占持有滑动窗口（longTriggerTimes）、
 * 队列（pendingReplyTriggers）、在途计数（activeReplyCounts）、提示冷却
 * （rateLimitNoticeTimes）这些内存容器与计时，把已经算好的标量喂给纯函数，
 * 按返回的决策执行副作用。发言/贴纸/反应全部工具化（见
 * ai/tools/replyToolset.ts）：具体怎么说、说几条、配不配贴纸由模型在工具
 * 对话（geminiReply.ts 的 callGemini）里自主决定，本文件负责触发是否被
 * 接纳、上下文拼装（promptContext.ts）与最终正文兜底。
 */

/**
 * 触发被丢弃时的明确反馈：限频滑动窗口打满、或并发闸等候队列打满时回一句
 * 「你们太快了」，而不是静默失踪让群友以为机器人坏了。提示自身带独立冷却
 * （每群至多一分钟一条，见 RATE_LIMIT_NOTICE_COOLDOWN_MS），刷屏场景下
 * 不会跟着刷。随机插话/媒体评价在并发位占满期间的丢弃不提示——没人在等
 * 那条回复，提示反而吵。
 */
function notifyRateLimited(chatId: number, now: number, generation: number = currentReplyGeneration(chatId)): void {
  const lastNoticeTime: number = rateLimitNoticeTimes.get(chatId) ?? 0;
  if (now - lastNoticeTime < RATE_LIMIT_NOTICE_COOLDOWN_MS) return;
  rateLimitNoticeTimes.set(chatId, now);
  void sendMessage(chatId, RATE_LIMIT_NOTICE_TEXT).then((sentMessageId: number | undefined) => {
    if (sentMessageId === undefined) return;
    // 跟其他几处发送一样报回主线程登记自发消息（见 generateAndSendReply 的
    // sendMessage 调用、callGemini 的 onStickerSent 回调）：这条提示同样可能
    // 落在频道，漏报的话频道自回环会被当成新内容，触发一轮不必要的 AI
    // 回复/随机复读。
    self.postMessage({ type: "sent", chatId, messageId: sentMessageId } satisfies AiSentMessage);
    // 也自录进对话缓存——这条提示同样是机器人在群里说的话，不留痕的话
    // 模型不知道自己刚说过「太快了接不过来」，被追问时接不上。
    if (botInfoState.current && isReplyGenerationCurrent(chatId, generation)) {
      recordChatMessage(chatId, botInfoState.current.id, botInfoState.current.first_name, "", botInfoState.current.username, RATE_LIMIT_NOTICE_TEXT);
    }
  });
}

/**
 * 生成并执行一轮 AI 回复。整个过程 fire-and-forget，不阻塞本线程的消息分发
 * （限频判定是同步的，其余都在异步任务里跑）。
 * 发言/贴纸/反应全部工具化（见 ai/tools/replyToolset.ts）：发单条还是像真人
 * 那样连发几条短句、配不配贴纸、扣不扣反应、挂不挂回复引用，都由模型在工具
 * 对话里自主决定——但不允许整轮沉默，每轮至少留下一个群友看得见的动作
 * （说话/贴纸/扣反应任选，见 consts/aiChatPrompts.ts 的 REPLY_ACTION_INSTRUCTION）。
 * 副作用在工具执行时当场发生；这里只组装工具集与回调，外加一道对所有触发
 * 类型生效的正文兜底（见 startReplyRound 尾注释）。
 * @param chatId 目标群聊。
 * @param replyToMessageId 触发这次回复的消息 ID：add_reaction 的目标；模型给
 *   send_message 传 reply_to_trigger: true 时的回复引用目标。
 * @param repliedBotText 若是「用户回复机器人」触发，被回复的机器人消息文本。
 * @param isRandomTrigger 是否是无人回复/@机器人、单纯按概率命中的随机插话。
 *   怎么接（挂不挂引用、要不要称呼对方）由模型自主判断，但必须回应
 *   （说话/贴纸/扣反应都算）——「插不插话」的闸门在触发概率那一层，
 *   命中了就要留下点动静。
 * @param mediaComment 若是「解析完图片/贴纸/GIF 后评价它」触发（见
 *   mediaIngest.ts 的 recordChatMedia），发送人与描述——回复指令改为评价，
 *   回复引用挂在那条媒体消息上（replyToMessageId 即那条消息）；5 分钟窗口
 *   限频照常适用，评价触发同样占限频名额。directTriggerReason 存在时是
 *   「媒体直接叫机器人」的必回触发：指令改为回复语气，并发闸打满时排队
 *   而非丢弃。
 */
export function generateAndSendReply(
  chatId: number,
  replyToMessageId: number,
  repliedBotText: string | undefined,
  isRandomTrigger: boolean,
  mediaComment?: MediaCommentContext
): void {
  const generation: number = currentReplyGeneration(chatId);
  // init 消息在 index.ts 里先于 runner 启动送出，FIFO 保证它先到；走到这里
  // 说明编排被改坏了，丢弃触发并留痕，别让流水线在缺身份的情况下硬跑。
  if (!botInfoState.current) {
    logger.error("aiChatWorker received trigger before init message; dropping.");
    return;
  }
  // 同群在途轮数封顶 REPLY_ROUND_MAX_CONCURRENT。Gemini 请求可持续几十秒，
  // 并发跑意味着后发的轮可能先结束、几轮的发言互相穿插——为了热闹群里
  // 不让真人干等，这点乱序是有意接受的权衡（见 consts/aiChat.ts 该常量
  // 注释）。打满期间怎么处置交给 admitTrigger（states/replyAdmission.ts）
  // 纯判定：随机插话/媒体评价直接丢弃——没人在等那条回复，错过时机再补
  // 反而突兀；回复/@ 是真人在等的交互，入队等空位腾出后按先来后到补跑
  // （见 drainReplyQueue），队列打满才丢。这道并发闸同时就是短时爆发的
  // 天然节流（见 consts/aiChat.ts 的 RATE_LIMIT_LONG_WINDOW_MS 注释）。
  const decision: AdmitDecision = admitTrigger({
    activeRounds: activeReplyCounts.get(chatId) ?? 0,
    queueSize: pendingReplyTriggers.get(chatId)?.size ?? 0,
    kind: triggerKindFor(isRandomTrigger, mediaComment),
  });
  switch (decision.action) {
    case "startRound":
      startReplyRound(chatId, replyToMessageId, repliedBotText, isRandomTrigger, mediaComment, undefined, generation);
      break;
    case "dropSilently":
      break;
    case "enqueue":
      pushReplyTrigger(chatId, replyToMessageId, repliedBotText, mediaComment);
      break;
    case "enqueueOverflow":
      // 被丢的是真人在等的交互，欠一条「太快了」提示好过静默失踪；提示
      // 压到某轮收尾腾出空位时再发（见 drainReplyQueue），不在此刻打断
      // 刚收尾那轮的连发短句。
      pendingOverflowNotices.add(chatId);
      break;
  }
}

/** 把 (isRandomTrigger, mediaComment) 分类成 admitTrigger 要的触发种类。
 *  判定顺序对齐原判断的 `isRandomTrigger || (mediaComment && !directTriggerReason)`
 *  短路顺序——isRandomTrigger 优先于 mediaComment，不可颠倒。 */
function triggerKindFor(isRandomTrigger: boolean, mediaComment: MediaCommentContext | undefined): TriggerKind {
  if (isRandomTrigger) return "random";
  if (mediaComment) return mediaComment.directTriggerReason ? "mediaDirect" : "mediaRandom";
  return "direct";
}

/**
 * 把一个直接触发（回复/@，或拿媒体回复机器人）压进该群的补跑队列，等
 * 并发位腾出后由 drainReplyQueue 补跑。仅在 admitTrigger 判定
 * action: "enqueue" 时调用——队列是否有空位已经判过。
 * @param mediaTrigger 媒体直接叫机器人的触发（见 MediaCommentContext 的
 *   directTriggerReason）：媒体解析是异步的，触发时转录尾部未必还是那条媒体消息，
 *   不能拿尾部当快照，改用解析出的发送人与描述。
 */
function pushReplyTrigger(chatId: number, replyToMessageId: number, repliedBotText: string | undefined, mediaTrigger?: MediaCommentContext): void {
  let queue: LinkedQueue<QueuedReplyTrigger> | undefined = pendingReplyTriggers.get(chatId);
  if (!queue) {
    queue = new LinkedQueue<QueuedReplyTrigger>();
    pendingReplyTriggers.set(chatId, queue);
  }
  if (mediaTrigger) {
    queue.push({
      replyToMessageId,
      repliedBotText,
      senderName: mediaTrigger.senderName,
      text: truncateInline(resolvedTagFor(mediaTrigger.kind, mediaTrigger.description), QUEUED_TRIGGER_SNIPPET_MAX_CHARS),
    });
    return;
  }
  // 触发消息本身刚被 record 过（主线程先 record 后 trigger，FIFO），缓存
  // 尾部就是它：快照发言人与正文，补跑时回复指令靠这份快照点名要回的
  // 具体消息（等轮到它时转录尾部早已是别的消息了）。防御空缓存的兜底
  // 正常走不到——直接触发必然先有一条被记录的文本消息。
  const triggerEntry: BufferedMessage | undefined = chatBuffers.get(chatId)?.last(1)[0];
  queue.push({
    replyToMessageId,
    repliedBotText,
    senderName: triggerEntry ? displayBufferedMessageName(triggerEntry) : "",
    text: triggerEntry ? truncateInline(triggerEntry.text, QUEUED_TRIGGER_SNIPPET_MAX_CHARS) : "",
  });
}

/**
 * 某轮结束腾出空位后，按先来后到补跑队列里的直接触发，直到并发位再次
 * 占满或队列耗尽。被限频闸丢弃的不占轮次：丢弃路径自带提示，继续放下
 * 一个。补跑轮结束后自己会再走到这里，队列持续排空。欠着的队列打满提示
 * 也在这里补发——刚收尾那轮的连发短句已经发完，其余在途轮的发言可能与
 * 提示穿插，接受（并发本身就放弃了发言不穿插的保证）。
 */
function drainReplyQueue(chatId: number): void {
  if (pendingOverflowNotices.delete(chatId)) {
    notifyRateLimited(chatId, Date.now());
  }
  const queue: LinkedQueue<QueuedReplyTrigger> | undefined = pendingReplyTriggers.get(chatId);
  if (!queue) return;
  while (queue.size > 0 && (activeReplyCounts.get(chatId) ?? 0) < REPLY_ROUND_MAX_CONCURRENT) {
    const next: QueuedReplyTrigger = queue.shift()!;
    startReplyRound(chatId, next.replyToMessageId, next.repliedBotText, false, undefined, next);
  }
  if (queue.size === 0) pendingReplyTriggers.delete(chatId);
}

/**
 * 实际启动一轮回复：过限频闸、占同群一个并发位（计数 +1）、异步执行完整
 * 的生成与发送流程；结束后释放占位并补跑等候队列（见 drainReplyQueue）。
 * 参数语义同 generateAndSendReply。
 * @param queuedTrigger 若本轮是排队补跑（见 drainReplyQueue），入队时的
 *   触发消息快照——回复指令改为点名那条具体消息；先跑的轮已顺带回应过它
 *   时换个说法简短接一句、或至少扣个反应，不允许沉默，正文兜底照常生效。
 *   被限频闸丢弃时
 *   不占位、不落账，drainReplyQueue 的循环条件靠计数未增长感知并继续放下
 *   一个。
 */
function startReplyRound(
  chatId: number,
  replyToMessageId: number,
  repliedBotText: string | undefined,
  isRandomTrigger: boolean,
  mediaComment?: MediaCommentContext,
  queuedTrigger?: QueuedReplyTrigger,
  generation: number = currentReplyGeneration(chatId)
): void {
  if (!isReplyGenerationCurrent(chatId, generation)) return;
  // generateAndSendReply 已挡过缺身份的触发；出队补跑路径能走到这里说明
  // init 早已到达（队列只在某轮跑过之后才可能有内容），这里只做类型收窄。
  const selfInfo: AiBotInfo | null = botInfoState.current;
  if (!selfInfo) return;

  // 本群 5 分钟滑动窗口限频：先把窗口外的旧触发挤掉，再交给 admitRound
  // （states/replyAdmission.ts）纯判定。占位闸和限频闸都过了才落账，
  // 避免被拒的触发白白占用配额。
  const now: number = Date.now();
  let longTimes: LinkedQueue<number> | undefined = longTriggerTimes.get(chatId);
  if (!longTimes) {
    longTimes = new LinkedQueue<number>();
    longTriggerTimes.set(chatId, longTimes);
  }
  while (longTimes.size > 0 && now - longTimes.peek()! >= RATE_LIMIT_LONG_WINDOW_MS) {
    longTimes.shift();
  }
  if (admitRound({ windowCount: longTimes.size }).action === "rateLimited") {
    notifyRateLimited(chatId, now, generation);
    return;
  }

  longTimes.push(now);
  activeReplyCounts.set(chatId, (activeReplyCounts.get(chatId) ?? 0) + 1);

  void (async (): Promise<void> => {
    const isActive = (): boolean => isReplyGenerationCurrent(chatId, generation);
    // 本轮的同群发贴纸锁句柄（见 ai/stickerSendLock.ts）：创建不抢占，第一次
    // send_sticker 走到发送时才抢；并发轮里只有抢到的那轮能发贴纸。外层
    // finally 兜底释放——锁的持有期严格等于本轮生命周期，异常中断也不遗留。
    const stickerLock: StickerSendLockControl = createStickerSendLock(chatId);
    // 本轮是否出错，在请求模型之前先掷一次骰子决定（而不是让模型自己判断
    // 要不要提供候选）：结果同时喂给 buildUserContent（决定要不要拼
    // TYPO_REQUIRED_INSTRUCTION——不出错就完全不提）和 createReplyToolset
    // （决定 send_message 当轮 schema 要不要暴露 typo_original_char/
    // typo_replacement_char 字段），两处必须用同一个值，这个概率数字才
    // 等于实际出错概率，见 consts/aiChat.ts 的 AI_TEXT_TYPO_PROBABILITY。
    const roundHasTypo: boolean = Math.random() < AI_TEXT_TYPO_PROBABILITY;
    try {
      const userContent: string | null = buildUserContent(chatId, selfInfo, { repliedBotText, isRandomTrigger, mediaComment, queuedTrigger, roundHasTypo });
      if (!userContent) return;

    // 心跳的生命周期覆盖整轮工具对话（生成耗时不可控，发送也发生在工具
    // 执行里），但从 idle 挡起步：生成/思考期间不亮状态，「正在输入/选择
    // 贴纸…」只在具体动作临发前由工具执行路径拉起有界窗口（见
    // ai/tools/replyToolset.ts 与 stickers.ts）——只扣反应的轮（合规回应，
    // 反应不拉起任何状态窗口）和违背指令零产出的轮都不发消息，全程无感，
    // 不会留下等不来消息的假输入状态。try/finally 保证即使
    // createReplyToolset/callGemini 抛异常，心跳也一定会被停掉。
      const heartbeat = startChatActionHeartbeat(chatId);
      try {
    // 工具执行成功后的回调：发出去的每条消息/贴纸描述行都自录进对话缓存
    // （普通群聊天 Telegram 不会把自己发出去的消息作为更新推送回来，不自录
    // 的话转录里永远缺自己那半边对话；配合 buildUserContent 里的 selfIdentity
    // 说明，模型才能在上下文中认出自己说过什么），消息 ID 报回主线程登记
    // 自发消息（频道帖例外：channel_post 更新会原样推回来，登记后自动流水线
    // 才能识别出是自己刚发的、整体跳过，见 auto/message.ts 的 isBotOwnMessage）。
        const ctx: ReplyToolContext = {
          chatId,
          replyToMessageId,
          chatAction: heartbeat,
          stickerLock,
          roundHasTypo,
          isActive,
          onMessageSent: (text: string, messageId: number): void => {
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
            if (isActive()) recordChatMessage(chatId, selfInfo.id, selfInfo.first_name, "", selfInfo.username, text);
          },
          onStickerSent: (stickerDescription: string, messageId: number): void => {
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
            if (isActive()) recordChatMessage(chatId, selfInfo.id, selfInfo.first_name, "", selfInfo.username, stickerDescription);
          },
        };
        const toolset: ReplyToolset = await createReplyToolset(ctx);
        const finalText: string | null = await callGemini(chatId, userContent, toolset);

        // 正文兜底，所有触发类型一视同仁：指令已不允许模型整轮沉默（见
        // REPLY_ACTION_INSTRUCTION），若它没走 send_message 工具、把话留在
        // 了最终正文里，就把正文当那句话发出去。只发贴纸/只扣反应的轮正文
        // 通常为空（两者都算合规回应），不会被硬塞一句重复出声；正文也空
        // 又什么动作都没做的轮没东西可兜，只能接受（执行侧无中生有不了）。
        // 放在心跳停止之前：兜底走同一条 send_message 工具路径，照样有临
        // 发前的「正在输入…」窗口，发出后挡位随之切回 idle。随机插话不挂
        // 回复引用（没有人在叫它，突然引用显得刻意），其余触发都挂在触发
        // 消息上点名回谁。
        if (finalText && toolset.messagesSent() === 0) {
          await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: finalText, reply_to_trigger: !isRandomTrigger }));
        }
      } finally {
        // 先停表再等本代所有在途状态请求落定，避免异常中断时仍有迟到请求
        // 在任务结束后重新显示「正在输入/选择贴纸…」。
        await heartbeat.stop();
      }
    } finally {
      // 先还发贴纸锁再释放占位：本轮若持锁，还回去之后并发轮/补跑轮才能
      // 再发贴纸。
      stickerLock.release();
      const remaining: number = (activeReplyCounts.get(chatId) ?? 1) - 1;
      if (remaining > 0) activeReplyCounts.set(chatId, remaining);
      else activeReplyCounts.delete(chatId);
      // 先释放占位再补跑：出队的触发经 startReplyRound 重新过限频闸，
      // 排队期间不占限频名额。
      drainReplyQueue(chatId);
    }
  })().catch((error: unknown) => {
    logger.error("Error in AI reply task:", error);
  });
}
