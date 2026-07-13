import { logger } from "./infra/logger";
import type { Context } from "grammy";
import type { ChatMember, ChatPermissions } from "@grammyjs/types";
import { lockedChats } from "./cache/antiRaid";
import { loadLockdowns, saveLockdowns } from "./infra/storage";
import { VERIFY_CALLBACK_PREFIX } from "./consts/antiRaid";
import { superviseWorker } from "./libs/supervisedWorker";
import type { AdoptLockdownsMessage, AntiRaidMember, AntiRaidWorkerEvent, AntiRaidWorkerMessage } from "./types";

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
 * 主线程唯一持有的状态是私密模式镜像（cache/antiRaid.ts），业务判定
 * 一概不读它，只用于两条恢复路径的 adopt 重放：Worker 崩溃重启后交给
 * 新 Worker，以及（经 lockdowns.json 持久化、由 initAntiRaid 加载）
 * 整个进程重启后交回——权限限制已实际落在群上，不重放就永远无人解锁。
 *
 * Worker 的启动、崩溃自愈（含节流放弃）、日志转投见 libs/supervisedWorker.ts。
 * 停机时未完成的验证窗口随线程丢弃（残留按钮点了会得到「已失效」应答）；
 * 未到期的私密模式则已持久化在 lockdowns.json 里，下次启动重放接管。
 */

/** 把镜像里仍在生效的私密模式打包成 adopt 消息（两条恢复路径共用）。 */
function buildAdoptMessage(): AdoptLockdownsMessage {
  return {
    type: "adopt",
    lockdowns: [...lockedChats].map(([chatId, originalPermissions]) => ({ chatId, originalPermissions })),
  };
}

const { post } = superviseWorker<AntiRaidWorkerMessage, AntiRaidWorkerEvent>({
  url: new URL("./workers/antiRaidWorker.ts", import.meta.url).href,
  label: "Anti-raid guard Worker",
  giveUpConsequence: "join verification and anti-raid features will silently stay disabled until the process restarts.",
  // Worker 回报的 lockdown/unlock 事件：维护主线程镜像并持久化。
  onEvent: (event) => {
    switch (event.type) {
      case "lockdown":
        lockedChats.set(event.chatId, event.originalPermissions);
        void saveLockdowns(lockedChats);
        break;
      case "unlock":
        lockedChats.delete(event.chatId);
        void saveLockdowns(lockedChats);
        break;
    }
  },
  // 崩溃的 Worker 带走了恢复计时器，但权限限制已实际落在群上；把镜像里
  // 仍在生效的私密模式重放给新 Worker 接管，重新计时、到期恢复。FIFO
  // 保证 adopt 先于此后的一切投递到达。待验证记录随旧线程丢失，无从重放
  // ——残留的验证按钮点了会得到「已失效」应答，重新进群即可。
  onRespawn: (postToNext) => {
    if (lockedChats.size > 0) {
      postToNext(buildAdoptMessage());
    }
  },
  onGiveUp: () => abandonLockdowns(),
});

/**
 * 自愈放弃后，镜像里还挂着的私密模式已无人恢复。主线程只做投递不碰
 * Telegram API，救不了这些群的权限，只能清掉镜像并在日志里点名。
 * lockdowns.json 里的记录特意不清：重启进程后 initAntiRaid 会重放给
 * 新 Worker，自动把权限恢复回去；不重启就只能由管理员手动恢复。
 */
function abandonLockdowns(): void {
  if (lockedChats.size === 0) return;
  logger.error(
    `以下群聊的私密模式已无人解除，请重启机器人进程（会自动恢复群权限），` +
    `或由管理员手动恢复（允许成员邀请新人）：` +
    [...lockedChats.keys()].join(", ")
  );
  lockedChats.clear();
}

/**
 * 启动时的私密模式接管：加载 lockdowns.json 里进程上次退出时仍在生效的
 * 私密模式，填充镜像并 adopt 给 Worker 重新排恢复计时。必须在 runner 开始
 * 投喂更新之前 await 完成——FIFO 保证 adopt 先于一切新事件到达，Worker 侧
 * 「私密模式下直接踢人」的判断对随后涌入的入群立即生效。
 */
export async function initAntiRaid(): Promise<void> {
  const persisted: Map<number, ChatPermissions> = await loadLockdowns();
  if (persisted.size === 0) return;

  for (const [chatId, originalPermissions] of persisted) {
    lockedChats.set(chatId, originalPermissions);
  }
  post(buildAdoptMessage());
  logger.log(`接管上次进程退出时仍在生效的私密模式：${[...persisted.keys()].join(", ")}`);
}

/** 从 grammY 的 User 对象里摘出投递给 Worker 的最小身份字段。 */
function pickMember(user: { id: number; username?: string; first_name?: string }): AntiRaidMember {
  return { id: user.id, username: user.username, first_name: user.first_name };
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

  const user = update.new_chat_member.user;
  if (user.is_bot) return; // 机器人（包括本天才自己）不需要验证

  const chatId: number = update.chat.id;
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
export function handleGroupJoinVerification(message: any): boolean {
  // 验证只发生在群聊里，私聊消息不必跨线程投递去查一次注定落空的 Map。
  if (message.chat?.type === "private") return false;

  if (message.new_chat_members && message.new_chat_members.length > 0) {
    for (const member of message.new_chat_members) {
      if (member.is_bot) continue; // 机器人（包括本天才自己）不需要验证
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

  post({
    type: "callback",
    callbackQueryId: query.id,
    chatId: query.message?.chat.id,
    targetUserId: Number(data.slice(VERIFY_CALLBACK_PREFIX.length)),
    from: pickMember(query.from),
  });
}
