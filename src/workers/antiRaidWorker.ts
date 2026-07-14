import { logger } from "../infra/logger";
import { InlineKeyboard } from "grammy";
import {
  sendMessage,
  deleteMessage,
  deleteMessageAfter,
  kickChatMember,
  answerCallbackQuery,
  joinVerificationApi,
} from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { formatMinSec } from "../libs/time";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../consts/telegram";
import { PRIVILEGED_USERS_ID } from "../infra/config";
import {
  ADMIN_CACHE_TTL_MS,
  COMMENT_JOIN_CORRELATE_MS,
  JOIN_THRESHOLD,
  JOIN_WINDOW_MS,
  LINKED_CHANNEL_TTL_MS,
  LOCKDOWN_KICK_DEDUPE_MS,
  LOCKDOWN_MS,
  RESTORE_RETRY_MS,
  VERIFICATION_BUTTON_TEXT,
  VERIFICATION_TIMEOUT_MS,
  VERIFY_CALLBACK_PREFIX,
  WELCOME_AUTO_DELETE_MS,
} from "../consts/antiRaid";
import {
  activeLockdowns,
  adminFetches,
  chatAdmins,
  joinWindows,
  linkedChannelFetches,
  linkedChannels,
  pendingVerifications,
  recentChannelComments,
} from "../cache/antiRaidWorker";
import type {
  AdoptableLockdown,
  AntiRaidMember,
  AntiRaidWorkerMessage,
  Lockdown,
  LockdownEvent,
  PendingVerification,
  TrackedChatMessage,
  UnlockEvent,
  VerifyCallbackMessage,
} from "../types";

/**
 * 入群守卫线程（Bun Worker）：入群验证 + 反刷群私密模式的合并流水线。
 * 主线程（src/auto/message.ts / index.ts → antiRaid.ts 代理）只做事件投递，所有
 * 状态与实际工作都在这里：验证窗口的建立/去重/超时踢人、验证按钮的应答、
 * 入群计数窗口、触发/延长私密模式、私密模式期间的删公告 + 踢人、到期
 * 恢复权限与失败重试。发往 Telegram 的调用不回主线程绕路——本线程
 * import telegram.ts 时会得到自己独立的 grammY Api 客户端（用带限流 +
 * 429 自动重试的 joinVerificationApi，突发的删/踢/发在这里排队，不占用
 * 主线程共享客户端）。error 日志经 logger.ts 的转发模式回传主线程统一落盘。
 *
 * 验证与反刷群共用状态，因此天然一致：recordJoin 触发私密模式的占位是
 * 同步落地的，同一批投递里越过阈值的那次入群，紧随其后的入群立刻就会
 * 走「直接踢出」分支，没有跨线程的镜像延迟。
 *
 * 私密模式的生效/解除以 lockdown/unlock 事件回报主线程——主线程据此维护
 * 各群的 ChatState.lockdown 记录（infra/storage.ts，随 state.json 持久化），
 * 在本线程崩溃重启后用 adopt 消息交还给新实例接管（待验证记录则随线程
 * 丢失：残留的验证按钮点了会得到「已失效」应答，重新进群即可）。
 */

declare var self: Worker;

function verificationKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function memberLabel(member: AntiRaidMember): string {
  return formatUserLabel({ id: member.id, username: member.username, first_name: member.first_name });
}

// —— 管理员表（管理员拉人免验证的判定依据） ——

/** 未过期的某群管理员 ID 集合；没拉取过或已过期则返回 undefined，让调用方走异步兜底。 */
function freshAdminIds(chatId: number): Set<number> | undefined {
  const cached = chatAdmins.get(chatId);
  if (!cached || Date.now() - cached.fetchedAt > ADMIN_CACHE_TTL_MS) return undefined;
  return cached.adminIds;
}

/** 全量拉取某群的管理员表并落缓存（带进行中去重，见 adminFetches）。 */
function fetchAdminIds(chatId: number): Promise<Set<number>> {
  let inFlight = adminFetches.get(chatId);
  if (!inFlight) {
    inFlight = joinVerificationApi
      .getChatAdministrators(chatId)
      .then((admins) => {
        const adminIds: Set<number> = new Set(admins.map((admin) => admin.user.id));
        chatAdmins.set(chatId, { adminIds, fetchedAt: Date.now() });
        return adminIds;
      })
      .finally(() => adminFetches.delete(chatId));
    adminFetches.set(chatId, inFlight);
  }
  return inFlight;
}

/**
 * 应用一条管理员任免事件（主线程从 chat_member 更新里提取）。只增删已有的
 * 缓存条目——还没按需拉取过的群没有条目可改，之后的首次全量拉取天然是最新的。
 */
function applyAdminChange(chatId: number, userId: number, isAdmin: boolean): void {
  const cached = chatAdmins.get(chatId);
  if (!cached) return;
  if (isAdmin) {
    cached.adminIds.add(userId);
  } else {
    cached.adminIds.delete(userId);
  }
}

// —— 入群验证 ——

/**
 * 写入一个去重占位记录：不是真的在等验证，只是给同一次入群的另一路投递
 * （chat_member 更新 / new_chat_members 服务消息）留出 LOCKDOWN_KICK_DEDUPE_MS
 * 的去重窗口，到期自删。exempt（管理员拉人/身份入群、频道评论豁免）防止
 * 后到的那一路重新开验证窗口；kicked（私密模式下已直接踢出）防止重复
 * 计数/重复踢人。
 */
function setDedupePlaceholder(
  key: string,
  chatId: number,
  userId: number,
  label: string,
  flags: { exempt?: boolean; kicked?: boolean; isBot?: boolean }
): void {
  pendingVerifications.set(key, {
    chatId,
    userId,
    label,
    messageIds: [],
    timeout: setTimeout(() => pendingVerifications.delete(key), LOCKDOWN_KICK_DEDUPE_MS),
    ...flags,
  });
}

/**
 * 删除某个待验证成员被追踪的所有消息（如果有的话，包括入群公告、机器人的
 * 提醒消息，以及 TA 在等待期间发送的任何内容），将其踢出聊天，并发布一条通知
 * ——此时提到过 TA 的入群公告/提醒消息都已被删除，这条通知是关于谁被移除、
 * 为何被移除的唯一痕迹。在 1 分 30 秒窗口到期、仍未点击验证按钮时执行。
 */
async function expireVerification(chatId: number, userId: number): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (!pending) return; // 已通过验证，或已经因为中途退群等原因被清理掉了
  pendingVerifications.delete(key);

  // 管理员拉人的异步豁免可能到期了还没落定（管理员表拉取在限流队列里排队，
  // 或重试后仍然失败）：踢人前最后核对一次拉人者身份。缓存热直接判；缓存
  // 冷就等一次全量拉取（与在途请求自动合并）。等待期间记录已被删除，迟到
  // 的撤销回调/按钮点击都会因查不到记录而安全放弃。
  if (pending.invitedBy !== undefined) {
    const inviterId: number = pending.invitedBy;
    const cachedAdmins: Set<number> | undefined = freshAdminIds(chatId);
    let inviterIsAdmin: boolean = cachedAdmins?.has(inviterId) === true;
    if (cachedAdmins === undefined) {
      try {
        inviterIsAdmin = (await fetchAdminIds(chatId)).has(inviterId);
      } catch (error: unknown) {
        logger.error(`Error rechecking admin-invite exemption before expiring verification in chat ${chatId}:`, error);
      }
    }
    if (inviterIsAdmin) {
      // 拉人者确是管理员：按豁免收尾——只删带按钮的提醒，入群公告和 TA 的
      // 发言都留下（这是合法成员），也不发踢人通知。等待期间若有新投递重开
      // 了记录，不去覆盖它。
      deletePendingReminders(chatId, pending);
      if (!pendingVerifications.has(key)) {
        setDedupePlaceholder(key, chatId, userId, pending.label, { exempt: true, isBot: pending.isBot });
      }
      return;
    }
  }

  for (const messageId of pending.messageIds) {
    await deleteMessage(chatId, messageId, joinVerificationApi);
  }
  await kickChatMember(chatId, userId, joinVerificationApi);
  const noticeText: string = pending.isBot
    ? `啧，${formatMinSec(VERIFICATION_TIMEOUT_MS)} 过去了都没有白名单大人愿意为机器人 ${pending.label} 作保，本天才把这个来路不明的铁疙瘩连痕迹一起清出去啦♡`
    : `啧，${pending.label} 磨磨蹭蹭 ${formatMinSec(VERIFICATION_TIMEOUT_MS)} 都点不出验证按钮，本天才把 TA 的痕迹清干净、顺手踢出去啦，杂鱼动作太慢咯♡`;
  const noticeMessageId: number | undefined = await sendMessage(chatId, noticeText, undefined, joinVerificationApi);
  if (noticeMessageId !== undefined) {
    deleteMessageAfter(chatId, noticeMessageId, KICK_NOTICE_AUTO_DELETE_MS, joinVerificationApi);
  }
}

/**
 * 给一条真实的待验证记录挂载「拉人者是不是管理员」的异步核查：全量拉取
 * 管理员表（顺手把缓存补热），确认是管理员则撤销验证窗口。首路投递创建
 * 记录时挂载；第二路投递若也带着拉人者（两路的到达顺序和 actor 都不保证
 * 一致）就再挂一次——fetchAdminIds 自带进行中去重，重复挂载只是对同一
 * 结果多检查一遍，先撤销者生效，后到的发现记录已被替换即放弃。
 */
function scheduleAdminInviteExemption(key: string, pending: PendingVerification, actorId: number): void {
  void (async (): Promise<void> => {
    try {
      const adminIds: Set<number> = await fetchAdminIds(pending.chatId);
      if (adminIds.has(actorId)) {
        const current = pendingVerifications.get(key);
        // 仅在当前验证记录未被其他事件（如离群、点击通过等）更改时进行撤销
        if (current === pending) {
          clearTimeout(pending.timeout);
          pendingVerifications.delete(key);
          // 撤销已发送的验证提醒消息（原始 + 回复式补发）
          deletePendingReminders(pending.chatId, pending);
          // 插入免验证占位记录，防止后续并发事件（如服务消息）重复触发验证
          setDedupePlaceholder(key, pending.chatId, pending.userId, pending.label, { exempt: true, isBot: pending.isBot });
        }
      }
    } catch (error: unknown) {
      logger.error(`Error fetching chat admins for admin-invite exemption in chat ${pending.chatId}:`, error);
    }
  })();
}

/**
 * 为新加入的成员启动（如果已在等待中则补充）一个验证窗口。设计上是幂等的：
 * `chat_member` 更新和 `new_chat_members` 服务消息（群组未隐藏入群消息时）
 * 可能针对同一次入群各自独立触发一次投递，后到达的那一次应该只是补充其
 * 消息 ID，而不是重启计时器/再发一次提醒。本函数是同步的：状态占位全部
 * 同步落地，网络请求一律 fire-and-forget——消息按 FIFO 逐条处理，同一波
 * 刷屏入群的后续投递不会被某一次踢人/发消息的网络往返卡住。
 * @param chatId 成员加入的聊天。
 * @param member 新加入的用户（id/username/first_name/isBot），主线程只过滤掉本机器人自身；
 *   其他机器人照常走验证，由白名单用户代点按钮作保（见 handleVerificationCallback）。
 * @param announcementMessageId 若本次投递由 `new_chat_members` 服务消息触发，则为该消息的 ID（用于之后删除）。
 * @param exempt 若为 true，该成员以管理员/群主身份入群（chat_member 路径可见身份），免验证。
 */
function ensureVerificationStarted(
  chatId: number,
  member: AntiRaidMember,
  announcementMessageId?: number,
  exempt?: boolean,
  actorId?: number
): void {
  const key: string = verificationKey(chatId, member.id);
  const existing = pendingVerifications.get(key);

  // 管理员拉人免验证的同步快路径：拉人者在特权白名单里，或命中未过期的
  // 管理员表缓存，则等同于管理员身份入群的豁免。特意放在私密模式分支之前
  // ——私密模式期间普通成员本就被禁止拉人，管理员拉进来的人应照常放行。
  // 缓存没拉取过/已过期时这里不命中，落到下方的异步兜底去全量拉取。
  if (!exempt && actorId !== undefined && actorId !== member.id) {
    exempt = PRIVILEGED_USERS_ID.includes(actorId) || freshAdminIds(chatId)?.has(actorId) === true;
  }

  // TA 刚在频道评论区发过言（留言先于本次 chat_member 更新到达，见
  // handleTrackedMessage 的暂存）：这次入群正是那条留言触发的自动拉群。
  // 直接回复频道帖的是确证的真人评论，直接豁免、连验证按钮都不闪；
  // 楼中楼回复无法确证线程根，走下方的正常验证 + 追发提醒到 TA 的回复下。
  const recentComment = takeRecentComment(chatId, member.id);
  const exemptViaChannelComment: boolean = !exempt && recentComment?.repliesToChannelPost === true;
  if (exemptViaChannelComment) {
    exempt = true;
  }

  if (exempt) {
    // 管理员/群主入群（典型如群主退群重进），不需要验证。new_chat_members
    // 服务消息不带身份信息，若它先到、已经开了真实验证窗口，在这里撤销并
    // 删掉提醒消息（提醒若还在限流队列里没落地，回填回调查不到记录会自删）；
    // 否则留一个豁免占位，防止稍后到达的服务消息重新开一个验证窗口。
    // TA 的入群公告不删、发言不追踪——这是合法成员。
    if (existing) {
      if (existing.kicked || existing.exempt) return;
      clearTimeout(existing.timeout);
      pendingVerifications.delete(key);
      deletePendingReminders(chatId, existing);
    }
    setDedupePlaceholder(key, chatId, member.id, memberLabel(member), { exempt: true, isBot: member.isBot });
    // 直接回复频道帖免验证：回帖本身就是真人操作，虽然不点验证按钮，
    // 也照样在帖子底下弹一条欢迎消息，让 TA 在频道侧能看到。
    if (exemptViaChannelComment && recentComment) {
      sendChannelCommentWelcome(chatId, memberLabel(member), recentComment.messageId);
    }
    return;
  }

  if (existing) {
    if (announcementMessageId !== undefined) {
      if (existing.kicked) {
        // 这个人已经在私密模式下被直接踢出了，这条才姗姗来迟的入群公告/服务
        // 消息也顺手清理掉，不需要留着等占位记录自然过期。
        void deleteMessage(chatId, announcementMessageId, joinVerificationApi);
      } else if (!existing.exempt) {
        existing.messageIds.push(announcementMessageId);
      }
    }
    // 两路投递的到达顺序与携带的 actor 都不保证一致（比如缺 from 的服务
    // 消息先到、没能挂上核查）：本路带着拉人者而验证窗口还开着时，给它
    // 补挂管理员核查，否则这条 return 会把异步豁免的机会掐掉。缓存热时
    // 不必挂——上方同步快路径刚查过，没命中就是真不是管理员。
    if (actorId !== undefined && actorId !== member.id && !existing.kicked && !existing.exempt && freshAdminIds(chatId) === undefined) {
      existing.invitedBy ??= actorId;
      scheduleAdminInviteExemption(key, existing, actorId);
    }
    return;
  }

  // 反防刷群统计：只在真正新建待验证记录时计数一次，chat_member 更新和
  // new_chat_members 服务消息若针对同一次入群各自触发投递，不会被重复计数。
  // 越过阈值时 triggerLockdown 的占位是同步落地的（见其注释），所以紧接着
  // 的 activeLockdowns 判断对这一次入群本身就已生效。
  recordJoin(chatId);

  // 群聊当前处于反防刷群触发的私密模式：这波入群高峰大概率还在持续，新成员
  // 大概率也是刷量的一部分，跳过质询流程直接踢出（kickChatMember 只是踢出、
  // 不封禁，以防误杀正常用户，之后仍可正常申请加入）。两类例外不无脑秒踢、
  // 走下方的正常验证（不点按钮再踢不迟）：评论区进来的人（recentComment 有
  // 暂存，楼中楼回复）；以及被他人拉进来的（actorId 不是本人）——私密模式
  // 本就禁止普通成员拉人，能拉进来的多半是管理员，只是管理员表缓存冷的时候
  // 上方同步快路径没命中，秒踢会把异步兜底（下方的 fetchAdminIds 撤销验证）
  // 的机会一并掐掉，误杀管理员拉的人。
  const invitedByOther: boolean = actorId !== undefined && actorId !== member.id;
  if (activeLockdowns.has(chatId) && !recentComment && !invitedByOther) {
    // 占位记录：必须在任何网络请求之前同步插入，防止同一次入群的另一路
    // 投递因为查不到 existing 而重新 recordJoin/重新踢一次。
    setDedupePlaceholder(key, chatId, member.id, memberLabel(member), { kicked: true, isBot: member.isBot });

    void (async (): Promise<void> => {
      if (announcementMessageId !== undefined) {
        await deleteMessage(chatId, announcementMessageId, joinVerificationApi);
      }
      await kickChatMember(chatId, member.id, joinVerificationApi);
    })().catch((error: unknown) => {
      logger.error("Error kicking member during anti-raid lockdown:", error);
    });
    return;
  }

  const pending: PendingVerification = {
    chatId,
    userId: member.id,
    label: memberLabel(member),
    isBot: member.isBot,
    invitedBy: invitedByOther ? actorId : undefined,
    messageIds: announcementMessageId !== undefined ? [announcementMessageId] : [],
    timeout: setTimeout(() => {
      void expireVerification(chatId, member.id).catch((error: unknown) => {
        logger.error("Error expiring join verification:", error);
      });
    }, VERIFICATION_TIMEOUT_MS),
  };
  pendingVerifications.set(key, pending);

  // 楼中楼回复先到、入群更新后到：把验证提醒追发到 TA 的回复下（频道侧
  // 看得到按钮），回复本身也补进追踪，验证超时的话一并清理。
  if (recentComment !== undefined) {
    pending.messageIds.push(recentComment.messageId);
    resendReminderReplyingTo(chatId, member.id, recentComment.messageId, true);
  }

  // 他人拉入群但上面的同步快路径没命中（管理员表缓存没拉取过/已过期）：
  // 异步全量拉取管理员表兜底——既回答了「拉人者是不是管理员」，也顺手把
  // 缓存补热，同群的下一次管理员拉人就能走同步快路径、不再闪验证按钮。
  if (actorId !== undefined && actorId !== member.id) {
    scheduleAdminInviteExemption(key, pending, actorId);
  }

  // 评论先到的入群在上面消费 recentComment 时已补发过锚定评论的提醒，
  // 原始独立提醒不必再发——发出去也会因 reminderSuperseded 在落地时被
  // 立即自删，白占两次限流配额，还会在群里闪一下。
  if (pending.reminderSuperseded) return;

  // 提醒消息不等待发送完成：它经过限流的 joinVerificationApi，真实刷群
  // 场景下若在这里 await，同一波入群投递会逐个排队等发消息，可能导致
  // 15 秒的反防刷群计数窗口在真正数满阈值之前就先重置——刷群反而检测
  // 不到。发送结果异步回填 messageIds 即可，不影响后续到期清理。
  // 机器人看不到这条提醒也点不了按钮（Bot API 不向机器人投递其他机器人的
  // 消息），提醒是说给群里的白名单用户听的：得有人代它点按钮作保。
  const reminderText: string = member.isBot
    ? `哦？谁把 ${memberLabel(member)} 这个机器人拎进来的？铁疙瘩自己可点不了按钮——` +
      `${formatMinSec(VERIFICATION_TIMEOUT_MS)}内得有白名单大人帮它点下面的按钮作保，` +
      `不然本天才就把这个来路不明的铁皮杂鱼扔出去哦♡`
    : `喂，${memberLabel(member)}，新来的杂鱼给本天才听好了，` +
      `${formatMinSec(VERIFICATION_TIMEOUT_MS)}内点下面的按钮证明你不是机器人，` +
      `不然本天才就把你的发言全部抹掉再一脚把你踢出去哦♡`;
  const verifyKeyboard: InlineKeyboard = new InlineKeyboard().text(VERIFICATION_BUTTON_TEXT, `${VERIFY_CALLBACK_PREFIX}${member.id}`);
  void sendMessage(chatId, reminderText, undefined, joinVerificationApi, verifyKeyboard)
    .then((reminderMessageId: number | undefined) => {
      if (reminderMessageId === undefined) return;
      // reminderSuperseded：这条原始提醒还没落地就已被回复式提醒取代
      //（TA 抢先开口说话了），落地即自删。
      if (pendingVerifications.get(key) === pending && !pending.reminderSuperseded) {
        pending.messageIds.push(reminderMessageId);
        pending.reminderMessageId = reminderMessageId;
      } else {
        // 限流排队太久，提醒消息落地时验证已经结束了（过期清理/通过/中途离群）。
        // 无论哪种结局，这条迟到的提醒不删的话都会永远留在聊天里，所以直接删掉
        // （验证通过的场景下，带按钮的验证信息本来也是要删除的）。
        void deleteMessage(chatId, reminderMessageId, joinVerificationApi);
      }
    })
    .catch((error: unknown) => {
      logger.error("Error sending join verification reminder:", error);
    });
}

/**
 * 取消一个待验证记录——用于该成员已经离开的情况。TA 的入群公告/发言不动
 * （人都走了，不值得再刷一串删除调用），但带验证按钮的提醒必须删掉：
 * 不删就成了永远指向「已失效」的孤儿按钮，长期留在群里。
 */
function cancelVerification(chatId: number, userId: number): void {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingVerifications.delete(key);
    // kicked/exempt 占位没有提醒可删；还没落地的提醒由其回填回调自删。
    if (!pending.kicked && !pending.exempt) {
      deletePendingReminders(chatId, pending);
    }
  }
}

/** 追踪某个待验证成员发送的消息，以便验证超时被踢出时能把这些痕迹一并清理掉。 */
function trackPendingMessage(chatId: number, userId: number, messageId: number): void {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  // kicked/exempt 为 true 时这只是去重占位（私密模式踢人后 / 管理员豁免），
  // 不是真的在等验证。
  if (!pending || pending.kicked || pending.exempt) return;

  pending.messageIds.push(messageId);
}

// —— 频道评论区入群的特殊处理 ——

/**
 * 本群有没有关联频道（getChat 的 linked_chat_id），带 TTL 缓存 + 进行中
 * 去重。没有关联频道的群不存在评论区，楼中楼判定应整体跳过——
 * message_thread_id 在普通回复链上也可能出现，不收窄的话普通群里的回复
 * 会误走「追发提醒」路径。缓存未命中时先按「有」处理（误判只是提醒的
 * 锚点选择不同，代价很小；漏判则会让评论区进来的真人错过频道侧的按钮），
 * 同时异步拉取回填，之后按真实结果判定。
 */
function chatHasLinkedChannel(chatId: number): boolean {
  const cached = linkedChannels.get(chatId);
  if (cached && Date.now() - cached.fetchedAt <= LINKED_CHANNEL_TTL_MS) return cached.hasLinked;
  if (!linkedChannelFetches.has(chatId)) {
    const inFlight: Promise<void> = joinVerificationApi
      .getChat(chatId)
      .then((chat) => {
        linkedChannels.set(chatId, { hasLinked: "linked_chat_id" in chat && chat.linked_chat_id !== undefined, fetchedAt: Date.now() });
      })
      .catch((error: unknown) => {
        logger.error(`Error fetching linked channel info for chat ${chatId}:`, error);
      })
      .finally(() => linkedChannelFetches.delete(chatId));
    linkedChannelFetches.set(chatId, inFlight);
  }
  return cached ? cached.hasLinked : true;
}

/**
 * 把带验证按钮的提醒以「回复 TA 那条消息」的形式补发一份。两个场景共用：
 * - 评论区的楼中楼回复（inCommentThread=true）：TA 很可能是从频道评论区
 *   留言被自动拉进群的，人在频道侧看不到群里的提醒。楼中楼无法确证线程
 *   根就是频道帖（Bot API 不能按 ID 反查消息），所以不豁免，而是追发到
 *   评论线程里（双向同步，按钮在频道侧可见可点）并重置验证计时。
 * - 群里正常发言（inCommentThread=false）：TA 都开口说话了还没点按钮，
 *   多半压根没注意到原提醒——改锚到 TA 的发言下（回复会给 TA 推通知），
 *   计时不重置。
 * 两个场景都会立刻删除原来那条入群时弹出的独立提醒（补发的这条取代它），
 * 也都不放水：不点照样超时踢人，消息照常追踪清理。
 */
function resendReminderReplyingTo(chatId: number, userId: number, targetMessageId: number, inCommentThread: boolean): void {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (!pending || pending.kicked || pending.exempt || pending.replyReminderRequested) return;
  pending.replyReminderRequested = true;
  // 之后的欢迎消息也回复同一条消息，楼中楼场景下才能同样落进评论线程。
  pending.welcomeAnchorMessageId = targetMessageId;

  // 原提醒被取代，立刻删除。定位按人不按时间：走的是 chatId:userId 键下
  // pending 记录里存的 reminderMessageId，删的必然是 TA 自己的那条提醒。
  // 已落地的直接删（顺手从待清理列表去掉，免得过期清理时再对它多打一次
  // 注定失败的删除调用）；还在限流队列里没落地的，由回填回调按
  // reminderSuperseded 标记自删。
  pending.reminderSuperseded = true;
  if (pending.reminderMessageId !== undefined) {
    const reminderIndex: number = pending.messageIds.indexOf(pending.reminderMessageId);
    if (reminderIndex >= 0) pending.messageIds.splice(reminderIndex, 1);
    void deleteMessage(chatId, pending.reminderMessageId, joinVerificationApi);
    pending.reminderMessageId = undefined;
  }

  let reminderText: string;
  if (inCommentThread) {
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      void expireVerification(chatId, userId).catch((error: unknown) => {
        logger.error("Error expiring join verification:", error);
      });
    }, VERIFICATION_TIMEOUT_MS);
    reminderText =
      `喂，${pending.label}，本天才瞧见你在评论区冒泡了。新来的杂鱼规矩要懂：` +
      `${formatMinSec(VERIFICATION_TIMEOUT_MS)}内点下面的按钮证明你不是机器人，` +
      `不然留言全删、人也一脚踢出去哦♡`;
  } else {
    reminderText =
      `喂，${pending.label}，话都说上了，下面的验证按钮倒是点一下啊杂鱼。` +
      `再装看不见的话，本天才可要连人带消息一块清出去咯♡`;
  }

  const verifyKeyboard: InlineKeyboard = new InlineKeyboard().text(VERIFICATION_BUTTON_TEXT, `${VERIFY_CALLBACK_PREFIX}${userId}`);
  void sendMessage(chatId, reminderText, targetMessageId, joinVerificationApi, verifyKeyboard)
    .then((reminderMessageId: number | undefined) => {
      if (reminderMessageId === undefined) return;
      if (pendingVerifications.get(key) === pending) {
        pending.messageIds.push(reminderMessageId);
        pending.replyReminderMessageId = reminderMessageId;
      } else {
        // 限流排队太久，落地时验证已结束（通过/过期/离群），迟到的提醒自删。
        void deleteMessage(chatId, reminderMessageId, joinVerificationApi);
      }
    })
    .catch((error: unknown) => {
      logger.error("Error sending follow-up verification reminder:", error);
    });
}

/**
 * 删除某待验证记录名下已落地的提醒消息：原始独立提醒与回复式补发提醒
 * （若有）。原提醒被取代（reminderSuperseded）后 reminderMessageId 已置空、
 * 活着的是 replyReminderMessageId，所有撤销验证的路径都必须两个一起删，
 * 否则带按钮的提醒会成为孤儿永远留在群里。还没落地的不用管——其回填
 * 回调发现验证记录已被替换/删除时会自删。
 */
function deletePendingReminders(chatId: number, pending: PendingVerification): void {
  if (pending.reminderMessageId !== undefined) {
    void deleteMessage(chatId, pending.reminderMessageId, joinVerificationApi);
  }
  if (pending.replyReminderMessageId !== undefined) {
    void deleteMessage(chatId, pending.replyReminderMessageId, joinVerificationApi);
  }
}

/**
 * 直接回复频道帖免验证时，在帖子底下（回复 TA 那条评论）补一条欢迎消息，
 * WELCOME_AUTO_DELETE_MS 后自动清理——不点验证按钮的豁免路径原本没有
 * 任何反馈，TA 完全不知道自己已经通过，补上这条能在频道侧看到的欢迎。
 */
function sendChannelCommentWelcome(chatId: number, label: string, anchorMessageId: number): void {
  void sendMessage(chatId, `哼，${label} 老实巴交的在帖子底下冒个了泡，本天才大发慈悲免了你的验证，欢迎杂鱼入群~♡`, anchorMessageId, joinVerificationApi)
    .then((welcomeMessageId: number | undefined) => {
      if (welcomeMessageId !== undefined) {
        deleteMessageAfter(chatId, welcomeMessageId, WELCOME_AUTO_DELETE_MS, joinVerificationApi);
      }
    })
    .catch((error: unknown) => {
      logger.error("Error sending channel-comment welcome message:", error);
    });
}

/**
 * 在频道评论区留言的成员免验证：在关联频道的帖子下留言本身就是真人操作
 * （Telegram 正因这次留言才把 TA 自动拉进讨论群），不需要再点按钮自证——
 * 而且 TA 人在频道那侧的评论界面，多半根本看不到群里的验证按钮，硬要求
 * 只会把真人误踢。撤销验证窗口、删掉带按钮的提醒消息，并留一个豁免占位
 * 给可能迟到的 new_chat_members 服务消息去重。TA 已发的消息一概不删——
 * 那是合法的评论；另外在这条评论下补一条欢迎消息，让 TA 知道已经放行。
 */
function passVerificationForChannelComment(chatId: number, userId: number, messageId: number): void {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (!pending || pending.kicked || pending.exempt) return;

  clearTimeout(pending.timeout);
  deletePendingReminders(chatId, pending);
  // 覆盖为豁免占位（同管理员拉人免验证）：提醒消息若还在限流队列里没落地，
  // 其回填回调查到记录已被替换，会把迟到的提醒自删。
  setDedupePlaceholder(key, chatId, userId, pending.label, { exempt: true });
  sendChannelCommentWelcome(chatId, pending.label, messageId);
}

/**
 * 暂存一条「发言者当前没有待验证记录」的评论区留言/线程回复，等这条留言
 * 触发的自动拉群（chat_member 更新可能后到）来消费。同一人连发多条只留
 * 最新的；直接回复频道帖的标记一旦出现就保持（豁免的确证不被后续楼中楼
 * 回复降级）。
 */
function rememberRecentComment(chatId: number, userId: number, messageId: number, repliesToChannelPost: boolean): void {
  const key: string = verificationKey(chatId, userId);
  const existing = recentChannelComments.get(key);
  if (existing) clearTimeout(existing.cleanup);
  recentChannelComments.set(key, {
    messageId,
    repliesToChannelPost: repliesToChannelPost || existing?.repliesToChannelPost === true,
    cleanup: setTimeout(() => recentChannelComments.delete(key), COMMENT_JOIN_CORRELATE_MS),
  });
}

/** 消费（取出并删除）某人最近暂存的评论区留言，没有则返回 undefined。 */
function takeRecentComment(chatId: number, userId: number): { messageId: number; repliesToChannelPost: boolean } | undefined {
  const key: string = verificationKey(chatId, userId);
  const entry = recentChannelComments.get(key);
  if (!entry) return undefined;
  clearTimeout(entry.cleanup);
  recentChannelComments.delete(key);
  return { messageId: entry.messageId, repliesToChannelPost: entry.repliesToChannelPost };
}

/**
 * 处理一条普通群消息投递：先识别关联频道的评论区活动，再交给消息追踪。
 * 判定只看消息自带信号（外加按群的关联频道开关）：直接回复频道帖（确证
 * 的评论区留言）→ 免验证放行；有关联频道的群里的线程内回复（楼中楼，
 * 无法确证线程根是频道帖）→ 不豁免，把验证提醒追发到 TA 的回复下让频道
 * 侧能看到按钮。两者若先于入群更新到达（顺序不保证），先暂存、入群时
 * 消费。其余消息照常追踪，且待验证成员开口说话时把验证提醒改锚到 TA 的
 * 发言下、删除原提醒。
 */
function handleTrackedMessage(msg: TrackedChatMessage): void {
  const inCommentThread: boolean =
    msg.repliesToChannelPost === true ||
    (msg.isThreadReply === true && chatHasLinkedChannel(msg.chatId));
  if (inCommentThread) {
    if (!pendingVerifications.has(verificationKey(msg.chatId, msg.userId))) {
      // 这条留言若正触发自动拉群，其 chat_member 更新可能还没到（两个事件
      // 的到达顺序不保证）：暂存，入群时由 ensureVerificationStarted 消费。
      rememberRecentComment(msg.chatId, msg.userId, msg.messageId, msg.repliesToChannelPost === true);
      return;
    }
    if (msg.repliesToChannelPost) {
      passVerificationForChannelComment(msg.chatId, msg.userId, msg.messageId);
      return;
    }
  }

  // 楼中楼回复不豁免、普通发言更不豁免：消息照常落进追踪，且待验证成员
  // 开口即把验证提醒补发为回复 TA 消息的形式（楼中楼进评论线程并重置
  // 计时，普通发言只改锚），原独立提醒随之删除。
  trackPendingMessage(msg.chatId, msg.userId, msg.messageId);
  resendReminderReplyingTo(msg.chatId, msg.userId, msg.messageId, inCommentThread);
}

/**
 * 处理入群验证按钮的点击。只有验证记录对应的那个新成员本人点击才算数——
 * 别人点了会得到一个提示气泡，不会帮 TA 通过验证，防止群友手滑帮僵尸端
 * 点开验证。唯一例外：待验证的是个机器人时（机器人永远点不了按钮），
 * PRIVILEGED_USERS_ID 白名单用户可以代它点击作保。验证通过后：删除带
 * 按钮的验证提醒消息，发一条欢迎消息并在 WELCOME_AUTO_DELETE_MS 后自动
 * 清理，不在聊天里留下长期痕迹。
 */
async function handleVerificationCallback(msg: VerifyCallbackMessage): Promise<void> {
  if (msg.chatId === undefined) {
    await answerCallbackQuery(msg.callbackQueryId, undefined, false, joinVerificationApi);
    return;
  }

  const key: string = verificationKey(msg.chatId, msg.targetUserId);
  const pending = pendingVerifications.get(key);

  if (msg.from.id !== msg.targetUserId) {
    const vouchingForBot: boolean = pending?.isBot === true && PRIVILEGED_USERS_ID.includes(msg.from.id);
    if (!vouchingForBot) {
      const rejectText: string = pending?.isBot === true
        ? "帮机器人作保是白名单大人的特权，杂鱼别乱点～"
        : "这不是你的验证按钮哦，杂鱼别乱点～";
      await answerCallbackQuery(msg.callbackQueryId, rejectText, true, joinVerificationApi);
      return;
    }
  }

  if (!pending || pending.kicked || pending.exempt) {
    await answerCallbackQuery(msg.callbackQueryId, "验证已经失效啦，再试试重新进群吧", true, joinVerificationApi);
    return;
  }

  // 状态在任何 await 之前同步清掉：重复点击/并发点击的后到者会走上面的
  // 「已失效」分支，不会重复发欢迎消息。
  clearTimeout(pending.timeout);
  pendingVerifications.delete(key);
  await answerCallbackQuery(msg.callbackQueryId, "验证通过啦～", false, joinVerificationApi);
  if (pending.reminderMessageId !== undefined) {
    await deleteMessage(msg.chatId, pending.reminderMessageId, joinVerificationApi);
  }
  if (pending.replyReminderMessageId !== undefined) {
    await deleteMessage(msg.chatId, pending.replyReminderMessageId, joinVerificationApi);
  }
  // 欢迎消息回复补发提醒锚定的那条消息（若有）：楼中楼场景下随之落进
  // 评论线程，TA 在频道侧也能看到；普通验证（没补发过提醒）则照旧平发。
  // 机器人是白名单用户代点通过的，msg.from 是作保人而非被验证者，欢迎语
  // 里两个都要点名。
  const welcomeText: string = msg.from.id !== msg.targetUserId
    ? `哼，既然 ${memberLabel(msg.from)} 大人愿意为机器人 ${pending.label} 作保，本天才就勉为其难放这个铁疙瘩进来啦~♡`
    : `哼，算你机灵，${memberLabel(msg.from)} 通过验证啦，欢迎杂鱼入群~♡`;
  const welcomeMessageId: number | undefined = await sendMessage(msg.chatId, welcomeText, pending.welcomeAnchorMessageId, joinVerificationApi);
  if (welcomeMessageId !== undefined) {
    deleteMessageAfter(msg.chatId, welcomeMessageId, WELCOME_AUTO_DELETE_MS, joinVerificationApi);
  }
}

// —— 反刷群私密模式 ——

/** 安排一次到期恢复（或失败重试），返回可被 clearTimeout 的计时器。 */
function scheduleRestore(chatId: number, delayMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void restoreChat(chatId).catch((error: unknown) => {
      logger.error("Error restoring chat permissions after anti-raid lockdown:", error);
    });
  }, delayMs);
}

/**
 * 记录一次已确认的新成员加入（由 ensureVerificationStarted 在去重后调用）。
 * 滑动窗口：最近 JOIN_WINDOW_MS 内的入群人数超过阈值即触发临时私密模式——
 * 不用「首次入群起算、到点整体清零」的固定桶，是为了防住横跨桶边界的刷群
 * （前桶尾 + 后桶头各塞半个阈值，固定桶永远数不满）。
 */
function recordJoin(chatId: number): void {
  const now: number = Date.now();
  let window = joinWindows.get(chatId);
  if (!window) {
    window = { timestamps: [], resetTimeout: setTimeout(() => joinWindows.delete(chatId), JOIN_WINDOW_MS) };
    joinWindows.set(chatId, window);
  } else {
    // 清理计时器在每次入群时重置：它到期即意味着窗口静默满 JOIN_WINDOW_MS，
    // 届时所有时间戳都已过期，整个条目可以安全删除。
    clearTimeout(window.resetTimeout);
    window.resetTimeout = setTimeout(() => joinWindows.delete(chatId), JOIN_WINDOW_MS);
  }

  const cutoff: number = now - JOIN_WINDOW_MS;
  while (window.timestamps.length > 0 && window.timestamps[0]! <= cutoff) {
    window.timestamps.shift();
  }
  window.timestamps.push(now);

  if (window.timestamps.length > JOIN_THRESHOLD) {
    void triggerLockdown(chatId, window.timestamps.length).catch((error: unknown) => {
      logger.error("Error triggering anti-raid lockdown:", error);
    });
  }
}

/**
 * 禁止群内普通成员拉人（将默认权限中的 can_invite_users 设为 false），
 * LOCKDOWN_MS 后自动恢复原始权限。若群已处于私密模式（说明入群高峰仍在持续），
 * 则只延长恢复计时，不重复调用 setChatPermissions 或重复发通知。
 */
async function triggerLockdown(chatId: number, joinCount: number): Promise<void> {
  const existing = activeLockdowns.get(chatId);
  if (existing) {
    clearTimeout(existing.restoreTimeout);
    existing.restoreTimeout = scheduleRestore(chatId, LOCKDOWN_MS);
    return;
  }

  // 先同步占位再发起网络请求：recordJoin 对本函数是 fire-and-forget 调用，
  // 同一波入群高峰里，getChat/setChatPermissions 落地前可能已有好几次触发
  // 都跑到这里——若不先占位，它们都会看到"尚未加锁"，导致重复调用 API，
  // 且各自的 restoreTimeout 会互相覆盖，可能让锁定提前解除。同步占位还让
  // ensureVerificationStarted 里的 activeLockdowns 判断对同一批入群立即生效。
  const placeholder: Lockdown = {
    originalPermissions: {},
    restoreTimeout: scheduleRestore(chatId, LOCKDOWN_MS),
    permissionsApplied: false,
  };
  activeLockdowns.set(chatId, placeholder);

  try {
    const chat = await joinVerificationApi.getChat(chatId);
    placeholder.originalPermissions = ("permissions" in chat && chat.permissions) || {};
    await joinVerificationApi.setChatPermissions(chatId, { ...placeholder.originalPermissions, can_invite_users: false });
    placeholder.permissionsApplied = true;
    // 限制此刻才真正落地：真实刷群下上面两个调用可能在限流队列里排了几分钟，
    // 占位期的 5 分钟计时可能已耗尽（restoreChat 正以 RESTORE_RETRY_MS 的短
    // 间隔轮询等着）。从生效时刻重新起算满额 LOCKDOWN_MS，不然锁定可能在
    // 落地后 30 秒内就被那个轮询解除。
    clearTimeout(placeholder.restoreTimeout);
    placeholder.restoreTimeout = scheduleRestore(chatId, LOCKDOWN_MS);
  } catch (error: unknown) {
    clearTimeout(placeholder.restoreTimeout);
    activeLockdowns.delete(chatId);
    throw error;
  }

  // 权限已实际落地，此刻才向主线程回报——镜像里只该出现真正生效了的私密
  // 模式，adopt 重放时「恢复原始权限」才不会把从未改过权限的群改坏。
  self.postMessage({ type: "lockdown", chatId, originalPermissions: placeholder.originalPermissions } satisfies LockdownEvent);

  await sendMessage(
    chatId,
    `哼，${JOIN_WINDOW_MS / 1000} 秒内冲进来了 ${joinCount} 个杂鱼，本天才怀疑是有人在拉人头，先禁止普通成员邀请新人 ${LOCKDOWN_MS / 60_000} 分钟压压惊♡`,
    undefined,
    joinVerificationApi
  );
}

/**
 * 私密模式到期后，恢复群组原本的默认权限。
 * 恢复调用成功之前绝不能把 lockdown 记录从 map 里删掉：否则一旦
 * setChatPermissions 失败（网络抖动、429 等），记录没了、无人重试，
 * 群的 can_invite_users 就永久卡在 false，只能等管理员发现后手动救。
 * 失败时保留记录并安排稍后重试；重试期间私密模式仍然生效（unlock 事件
 * 也尚未发出），与「权限实际仍被限制着」的事实一致。
 */
async function restoreChat(chatId: number): Promise<void> {
  const lockdown = activeLockdowns.get(chatId);
  if (!lockdown) return;

  // 还在 triggerLockdown 的占位阶段（真实刷群下 getChat/setChatPermissions
  // 可能在限流队列里排队数分钟，甚至比 LOCKDOWN_MS 还久）：限制根本没落地，
  // originalPermissions 还是空对象，绝不能拿去"恢复"——那会把全群权限清零。
  // 稍后重试，等 triggerLockdown 完成（置位 permissionsApplied）或失败自删。
  if (!lockdown.permissionsApplied) {
    clearTimeout(lockdown.restoreTimeout);
    lockdown.restoreTimeout = scheduleRestore(chatId, RESTORE_RETRY_MS);
    return;
  }

  try {
    await joinVerificationApi.setChatPermissions(chatId, lockdown.originalPermissions);
  } catch (error: unknown) {
    logger.error(`Failed to restore chat permissions for ${chatId}, retrying in ${RESTORE_RETRY_MS / 1000}s:`, error);
    clearTimeout(lockdown.restoreTimeout);
    lockdown.restoreTimeout = scheduleRestore(chatId, RESTORE_RETRY_MS);
    return;
  }

  activeLockdowns.delete(chatId);
  self.postMessage({ type: "unlock", chatId } satisfies UnlockEvent);
  await sendMessage(chatId, `${LOCKDOWN_MS / 60_000} 分钟到啦，解除限制，普通成员又能拉人了，杂鱼们悠着点哦♡`, undefined, joinVerificationApi);
}

/**
 * 接管上一个（已崩溃的）Worker 留下的私密模式：内存状态随线程一起没了，
 * 但权限限制已实际落在群上，必须重新排恢复计时，否则永远无人解锁。
 * 计时从满额 LOCKDOWN_MS 重新起算——崩溃前已过去多久无从得知，宁可多锁
 * 一会儿也不能不解锁。
 */
function adoptLockdowns(lockdowns: AdoptableLockdown[]): void {
  for (const { chatId, originalPermissions } of lockdowns) {
    if (activeLockdowns.has(chatId)) continue;
    // 镜像里只会出现权限已实际落地的私密模式（lockdown 事件在
    // setChatPermissions 成功后才发），接管的记录直接视为已生效。
    activeLockdowns.set(chatId, {
      originalPermissions,
      restoreTimeout: scheduleRestore(chatId, LOCKDOWN_MS),
      permissionsApplied: true,
    });
  }
}

self.onmessage = (event: MessageEvent<AntiRaidWorkerMessage>) => {
  const msg: AntiRaidWorkerMessage = event.data;
  switch (msg.type) {
    case "join":
      ensureVerificationStarted(msg.chatId, msg.member, msg.announcementMessageId, msg.exempt, msg.actorId);
      break;
    case "left":
      cancelVerification(msg.chatId, msg.userId);
      break;
    case "message":
      handleTrackedMessage(msg);
      break;
    case "callback":
      void handleVerificationCallback(msg).catch((error: unknown) => {
        logger.error("Error handling join verification callback:", error);
      });
      break;
    case "adopt":
      adoptLockdowns(msg.lockdowns);
      break;
    case "adminsChanged":
      applyAdminChange(msg.chatId, msg.userId, msg.isAdmin);
      break;
  }
};
