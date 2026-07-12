import { logger, relayLogMessage } from "./logger";
import type { Context } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import { lockedChats } from "./cache/antiRaid";
import { VERIFY_CALLBACK_PREFIX } from "./consts/antiRaid";
import type { AdoptLockdownsMessage, AntiRaidMember, AntiRaidWorkerEvent, AntiRaidWorkerMessage, ForwardedLog } from "./types";

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
 * 主线程唯一持有的状态是私密模式镜像（cache/antiRaid.ts），只用于
 * Worker 崩溃重启后的 adopt 重放，业务判定一概不读它。
 */

// Worker 崩溃自愈的节流，逻辑与 aiChat.ts 一致：短时间内反复崩溃就放弃
// 自愈（多半是代码本身有 bug，重启也没用），只是安静地丢弃后续消息；
// 崩溃很稀疏则每次都正常重启。
const MAX_RESTARTS: number = 5;
const RESTART_WINDOW_MS: number = 60_000;
let restartTimestamps: number[] = [];

// Worker 在模块加载时启动一次。unref 让它不阻止进程退出——停机时未完成的
// 验证窗口/未到期的私密模式随之丢弃，与旧实现（主线程里的计时器随进程退出
// 丢弃）行为一致。为 null 代表自愈已放弃，post() 此时安静地丢弃消息——
// 不能再对着一个已终止的 Worker postMessage（Bun 会同步抛 InvalidStateError）。
let worker: Worker | null = createWorker();

function createWorker(): Worker {
  const w: Worker = new Worker(new URL("./workers/antiRaidWorker.ts", import.meta.url).href);
  w.unref();
  w.onmessage = (event: MessageEvent<ForwardedLog | AntiRaidWorkerEvent>) => {
    const data = event.data;
    if (data && typeof data === "object" && "__log" in data) {
      // Worker 线程里的 logger 处于转发模式（见 logger.ts 模块头注释）：
      // error 日志包着 ForwardedLog 信封回传，这里转投主线程唯一的落盘线程。
      relayLogMessage(data.__log);
      return;
    }
    switch (data.type) {
      case "lockdown":
        lockedChats.set(data.chatId, data.originalPermissions);
        break;
      case "unlock":
        lockedChats.delete(data.chatId);
        break;
    }
  };
  w.onerror = (event: ErrorEvent) => {
    logger.error("入群守卫 Worker 出错，准备重启：", event.message || event.error || event);
    // Bun 里 Worker 内部一旦抛出未捕获异常就会直接终止该 Worker 线程（见
    // aiChat.ts 同款注释），这里不需要再手动 terminate，直接换新实例顶上。
    const now: number = Date.now();
    restartTimestamps = restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
    if (restartTimestamps.length >= MAX_RESTARTS) {
      logger.error(
        `入群守卫 Worker 在 ${RESTART_WINDOW_MS / 1000} 秒内已重启 ${MAX_RESTARTS} 次，放弃自愈——` +
        `入群验证与反刷群功能此后静默失效，直到进程重启。`
      );
      abandonLockdowns();
      worker = null;
      return;
    }
    restartTimestamps.push(now);
    const next: Worker = createWorker();
    worker = next;
    // 崩溃的 Worker 带走了恢复计时器，但权限限制已实际落在群上；把镜像里
    // 仍在生效的私密模式重放给新 Worker 接管，重新计时、到期恢复。FIFO
    // 保证 adopt 先于此后的一切投递到达。待验证记录随旧线程丢失，无从重放
    // ——残留的验证按钮点了会得到「已失效」应答，重新进群即可。
    if (lockedChats.size > 0) {
      const adopt: AdoptLockdownsMessage = {
        type: "adopt",
        lockdowns: [...lockedChats].map(([chatId, originalPermissions]) => ({ chatId, originalPermissions })),
      };
      next.postMessage(adopt);
    }
  };
  return w;
}

/**
 * 自愈放弃后，镜像里还挂着的私密模式已无人恢复。主线程只做投递不碰
 * Telegram API，救不了这些群的权限，只能清掉镜像并在日志里点名，由
 * 管理员手动把 can_invite_users 恢复回去。
 */
function abandonLockdowns(): void {
  if (lockedChats.size === 0) return;
  logger.error(
    `以下群聊的私密模式已无人解除，请管理员手动恢复群权限（允许成员邀请新人）：` +
    [...lockedChats.keys()].join(", ")
  );
  lockedChats.clear();
}

function post(message: AntiRaidWorkerMessage): void {
  worker?.postMessage(message);
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

  if (!wasActive && isActive) {
    post({ type: "join", chatId, member: pickMember(user) });
  } else if (wasActive && !isActive) {
    post({ type: "left", chatId, userId: user.id });
  }
}

/**
 * 接入通用消息处理器的入口函数：在群组未隐藏 `new_chat_members`/
 * `left_chat_member` 服务消息时顺带捕获它们（以便这些消息的 ID 也能被
 * Worker 追踪/清理），同时把每条消息的（chatId, userId, messageId）投递
 * 给 Worker，用于追踪待验证用户在等待期间发送的消息。入群/离群本身的
 * 检测由 handleChatMemberUpdate 驱动——与这些服务消息不同，它总是会触发。
 * @returns 若消息在此已被完全处理、调用方应跳过自身处理逻辑（入群公告），
 * 返回 true；否则返回 false，让消息正常继续流转。
 */
export function handleGroupJoinVerification(message: any): boolean {
  if (message.new_chat_members && message.new_chat_members.length > 0) {
    for (const member of message.new_chat_members) {
      if (member.is_bot) continue; // 机器人（包括本天才自己）不需要验证
      post({ type: "join", chatId: message.chat.id, member: pickMember(member), announcementMessageId: message.message_id });
    }
    return true;
  }

  if (message.left_chat_member) {
    post({ type: "left", chatId: message.chat.id, userId: message.left_chat_member.id });
    return false;
  }

  const userId: number | undefined = message.from?.id;
  if (userId !== undefined) {
    post({ type: "message", chatId: message.chat.id, userId, messageId: message.message_id });
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
