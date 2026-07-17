import { logger } from "./infra/logger";
import type { Context } from "grammy";
import type { ChatMember, Message } from "@grammyjs/types";
import { getAllChatStates, getOrCreateChatState, saveState } from "./infra/storage";
import { answerCallbackQuery } from "./infra/telegram";
import { isBotAdminIn, markBotAdminObserved } from "./infra/botAdmin";
import { LOCKDOWN_MS, VERIFY_CALLBACK_PREFIX } from "./consts/antiRaid";
import { superviseWorker } from "./libs/supervisedWorker";
import type { AdoptableLockdown, AdoptLockdownsMessage, AntiRaidMember, AntiRaidWorkerEvent, AntiRaidWorkerMessage, LockdownRecord } from "./types";

/**
 * 入群守卫入口（主线程侧代理）：入群验证 + 反刷群私密模式。真正的逻辑
 * ——验证窗口、超时踢人、按钮应答、入群计数、私密模式的触发/恢复、
 * 私密模式期间的删公告 + 踢人——全部在独立的 Bun Worker
 * （src/workers/antiRaidWorker.ts）里执行；主线程只从 grammY 更新里
 * 提取出无状态的事件投递过去，不发起任何 Telegram API 调用，让更新
 * 调度不被入群守卫的突发 API 流量抢占。postMessage 按 FIFO 送达，
 * 同一次入群「先 join、后 message/callback」的先后顺序在 Worker 侧
 * 保持不变。
 *
 * 主线程唯一持有的私密模式状态是各群 ChatState.lockdown 字段（storage.ts
 * 持有、随 state.json 持久化），业务判定一概不读它，只用于两条恢复路径的
 * adopt 重放：Worker 崩溃重启后交给新 Worker，以及整个进程重启后由
 * initAntiRaid 交回——权限限制已实际落在群上，不重放就永远无人解锁。
 *
 * Worker 的启动、崩溃自愈（含节流放弃）、日志转投见 libs/supervisedWorker.ts。
 * 停机时未完成的验证窗口随线程丢弃（残留按钮点了会得到「已失效」应答）；
 * 未到期的私密模式则已持久化在 state.json 里，下次启动重放接管。
 */

/**
 * 把一条已由 loadState 校验过的私密模式记录换算成可 adopt 的形态：
 * 真实剩余时长 = expiresAt - 此刻，夹到不为负。
 */
function toAdoptableLockdown(chatId: number, record: LockdownRecord, now: number): AdoptableLockdown {
  return { chatId, originalPermissions: record.originalPermissions, remainingMs: Math.max(0, record.expiresAt - now) };
}

/** 收集当前仍在生效的私密模式，换算出各自的真实剩余时长。 */
function collectActiveLockdowns(): AdoptableLockdown[] {
  const lockdowns: AdoptableLockdown[] = [];
  const now: number = Date.now();
  for (const [chatId, chatState] of getAllChatStates()) {
    if (chatState.lockdown) {
      lockdowns.push(toAdoptableLockdown(chatId, chatState.lockdown, now));
    }
  }
  return lockdowns;
}

/** 把仍在生效的私密模式打包成 adopt 消息（两条恢复路径共用）。 */
function buildAdoptMessage(): AdoptLockdownsMessage {
  return { type: "adopt", lockdowns: collectActiveLockdowns() };
}

const { post } = superviseWorker<AntiRaidWorkerMessage, AntiRaidWorkerEvent>({
  url: new URL("./workers/antiRaidWorker.ts", import.meta.url).href,
  label: "Anti-raid guard Worker",
  giveUpConsequence: "join verification and anti-raid features will silently stay disabled until the process restarts.",
  // Worker 回报的 lockdown/unlock 事件：写入对应群的 ChatState.lockdown
  // 并持久化（storage.ts 持有状态，落盘时全量写 state.json）。
  onEvent: (event) => {
    switch (event.type) {
      case "lockdown":
        // 权限真正落地的时刻就是现在（Worker 里 setChatPermissions 成功后
        // 立即 postMessage，postMessage 本身近乎瞬时）：expiresAt 记下来，
        // 供下次进程/Worker 重启时算出真实剩余时长重排计时，见
        // collectActiveLockdowns。
        getOrCreateChatState(event.chatId).lockdown = {
          originalPermissions: event.originalPermissions,
          expiresAt: Date.now() + LOCKDOWN_MS,
        };
        void saveState();
        break;
      case "unlock":
        delete getOrCreateChatState(event.chatId).lockdown;
        void saveState();
        break;
    }
  },
  // 崩溃的 Worker 带走了恢复计时器，但权限限制已实际落在群上；把仍在生效
  // 的私密模式重放给新 Worker 接管，重新计时、到期恢复。FIFO 保证 adopt
  // 先于此后的一切投递到达。待验证记录随旧线程丢失，无从重放——残留的
  // 验证按钮点了会得到「已失效」应答，重新进群即可。
  onRespawn: (postToNext) => {
    const adopt: AdoptLockdownsMessage = buildAdoptMessage();
    if (adopt.lockdowns.length > 0) {
      postToNext(adopt);
    }
  },
  onGiveUp: () => abandonLockdowns(),
});

/**
 * 自愈放弃后，还挂着的私密模式已无人恢复。主线程只做投递不碰 Telegram API，
 * 救不了这些群的权限，只能在日志里点名。ChatState.lockdown 特意不清：
 * 重启进程后 initAntiRaid 会重放给新 Worker，自动把权限恢复回去；不重启
 * 就只能由管理员手动恢复（自愈已放弃，进程内不会再有人读这份记录）。
 */
function abandonLockdowns(): void {
  const abandoned = collectActiveLockdowns();
  if (abandoned.length === 0) return;
  logger.error(
    `Nobody is left to lift lockdown mode for these chats; restart the bot process (it restores permissions automatically) ` +
    `or have an admin re-enable member invites manually: ` +
    abandoned.map((l) => l.chatId).join(", ")
  );
}

/**
 * 启动时的私密模式接管：把 state.json 里进程上次退出时仍在生效的私密模式
 * （已随 loadState() 载入各群 ChatState.lockdown）adopt 给 Worker 重新排
 * 恢复计时。必须在 runner 开始投喂更新之前调用——FIFO 保证 adopt 先于一切
 * 新事件到达，Worker 侧「私密模式下直接踢人」的判断对随后涌入的入群立即生效。
 */
export function initAntiRaid(): void {
  const adopt: AdoptLockdownsMessage = buildAdoptMessage();
  if (adopt.lockdowns.length === 0) return;

  post(adopt);
  logger.log(`Adopted lockdowns still active from previous process exit: ${adopt.lockdowns.map((l) => l.chatId).join(", ")}`);
}

/** 从 grammY 的 User 对象里摘出投递给 Worker 的最小身份字段。 */
function pickMember(user: { id: number; username?: string; first_name?: string; is_bot?: boolean }): AntiRaidMember {
  return { id: user.id, username: user.username, first_name: user.first_name, isBot: user.is_bot === true };
}

/** 某个 ChatMember 是否实际还在聊天中（相对于已离开/已被踢出而言）。 */
function isActiveChatMember(member: ChatMember): boolean {
  if (member.status === "left" || member.status === "kicked") return false;
  if (member.status === "restricted") return member.is_member;
  return true; // "member" | "administrator" | "creator"
}

/**
 * 处理 `chat_member` 更新：这是权威且始终会送达的入群/离群信号（不同于
 * `new_chat_members`/`left_chat_member` 服务消息——一旦群组开启了"隐藏入群/
 * 离群消息"，这些服务消息就完全不会再发送）。要接收非机器人自身成员的这类
 * 更新，需要机器人是群管理员——而封禁/删除消息本来也需要这个权限。
 */
export function handleChatMemberUpdate(ctx: Context): void {
  const update = ctx.chatMember;
  if (!update) return;

  const chatId: number = update.chat.id;
  const user = update.new_chat_member.user;
  // 自身的成员变动本来走 my_chat_member；这条排除必须放在最前面——万一
  // Telegram 真的也为机器人自己送来一条 chat_member（比如这次恰好就是自己
  // 被撤管理员），排在下面 markBotAdminObserved 之后会被误判：那条推理
  // （"收到别人的 chat_member 就证明自己此刻是管理员"）建立在"这是关于
  // 别人的更新"之上，套在这条报告自己被撤权的更新上会得出恰好相反的结论。
  if (user.id === ctx.me.id) return;

  // 能收到别人的 chat_member 更新，本身就证明机器人此刻是本群管理员——
  // 顺手记录（见 botAdmin.ts），这条路径无需（也不能）做非管理员门控：
  // 不是管理员时这类更新根本不会送达。
  markBotAdminObserved(chatId);

  // 机器人不再豁免——僵尸 bot 也会被批量拉进群刷屏，照常走验证（由白名单
  // 用户代点按钮作保）。
  const wasActive: boolean = isActiveChatMember(update.old_chat_member);
  const isActive: boolean = isActiveChatMember(update.new_chat_member);

  // 管理员任免（含管理员入群/离群）同样以 chat_member 更新送达：同步给
  // Worker 侧的管理员表缓存，让「管理员拉人免验证」的同步判定近乎实时，
  // 缓存 TTL 只是兜底。FIFO 保证它先于随后的 join/left 投递生效。
  const wasAdmin: boolean = update.old_chat_member.status === "administrator" || update.old_chat_member.status === "creator";
  const isAdmin: boolean = update.new_chat_member.status === "administrator" || update.new_chat_member.status === "creator";
  if (wasAdmin !== isAdmin) {
    post({ type: "adminsChanged", chatId, userId: user.id, isAdmin });
  }

  if (!wasActive && isActive) {
    // 以管理员/群主身份入群的（典型如群主退群重进）免验证。身份只有本路径
    // 可见，new_chat_members 服务消息里没有——所以不能简单跳过不投递，而要
    // 带 exempt 标记投给 Worker：若服务消息那一路已抢先开了验证窗口，Worker
    // 收到豁免后会将其撤销。
    post({ type: "join", chatId, member: pickMember(user), exempt: isAdmin, actorId: update.from.id });
  } else if (wasActive && !isActive) {
    post({ type: "left", chatId, userId: user.id });
  }
}

/**
 * 消息事件的投递入口，在 index.ts 里以中间件形式挂在所有命令处理器之前
 * ——这样待验证用户发的命令消息（/copy 之类）也会被追踪，超时踢人时
 * 一并清理，不给刷群脚本留「刷命令就删不掉」的空子。职责：在群组未隐藏
 * `new_chat_members`/`left_chat_member` 服务消息时顺带捕获它们（以便这些
 * 消息的 ID 也能被 Worker 追踪/清理），同时把每条消息的（chatId, userId,
 * messageId）投递给 Worker，用于追踪待验证用户在等待期间发送的消息。
 * 入群/离群本身的检测由 handleChatMemberUpdate 驱动——与这些服务消息
 * 不同，它总是会触发。
 * @returns 若消息在此已被完全处理、调用方应跳过后续处理逻辑（入群公告），
 * 返回 true；否则返回 false，让消息正常继续流转。
 */
export async function handleGroupJoinVerification(message: Message, botId: number): Promise<boolean> {
  // 验证只发生在群聊里，私聊消息不必跨线程投递去查一次注定落空的 Map。
  if (message.chat?.type === "private") return false;

  // 机器人不是本群管理员时整个入群守卫不启动：踢人/删消息都做不了，投递
  // 过去只会让 Worker 开一堆注定失败的验证窗口、刷一堆权限报错。已有身份
  // 记录时这个判定是同步的（不打 API），只有从未记录过的群会现查一次。
  // 入群公告照样吞掉（服务消息本来就不该流进复读/AI 流水线），只是不投递。
  if (!(await isBotAdminIn(message.chat.id))) {
    return !!(message.new_chat_members && message.new_chat_members.length > 0);
  }

  if (message.new_chat_members && message.new_chat_members.length > 0) {
    for (const member of message.new_chat_members) {
      // 机器人不再豁免（走白名单用户代点验证的流程），只跳过本天才自己
      // ——自己既不能验证自己，也不该被自己踢出去。
      if (member.id === botId) continue;
      post({ type: "join", chatId: message.chat.id, member: pickMember(member), announcementMessageId: message.message_id, actorId: message.from?.id });
    }
    return true;
  }

  if (message.left_chat_member) {
    post({ type: "left", chatId: message.chat.id, userId: message.left_chat_member.id });
    return false;
  }

  const userId: number | undefined = message.from?.id;
  if (userId !== undefined) {
    // 附带频道评论区的识别线索：在关联频道的帖子下留言的人会被 Telegram
    // 自动拉进讨论群，这是真人操作，Worker 据此免除验证（直接回复频道帖）
    // 或把验证提醒追发到 TA 的回复下（楼中楼）。
    post({
      type: "message",
      chatId: message.chat.id,
      userId,
      messageId: message.message_id,
      repliesToChannelPost: message.reply_to_message?.is_automatic_forward === true,
      isThreadReply: message.message_thread_id !== undefined,
    });
  }
  return false;
}

/**
 * 处理入群验证按钮的点击（callback_query）：解析出目标成员后整体投递给
 * Worker 应答与处理。前缀不匹配的 callback_query 与本模块无关，直接放过。
 */
export function handleVerificationCallback(ctx: Context): void {
  const query = ctx.callbackQuery;
  const data: string | undefined = query?.data;
  if (!query || !data || !data.startsWith(VERIFY_CALLBACK_PREFIX)) return;

  const targetUserId: number = Number(data.slice(VERIFY_CALLBACK_PREFIX.length));
  // callback_data 属于外部输入：前缀匹配不代表后半段一定是合法整数。NaN 若
  // 进入 Worker 会生成 "chatId:NaN" 状态键，按钮只会永远转圈且留下脏状态。
  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    void answerCallbackQuery(query.id, "验证请求无效", true);
    return;
  }

  post({
    type: "callback",
    callbackQueryId: query.id,
    chatId: query.message?.chat.id,
    targetUserId,
    from: pickMember(query.from),
  });
}
