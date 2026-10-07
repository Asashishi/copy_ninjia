import type { Context } from "grammy";
import { telegramSignal } from "../libs/telegramSignal";
import { logger } from "./logger";
import { bot } from "./telegram/mainClient";
import {
  clearChatStateField,
  getChatState,
  getOrCreateChatState,
  persistChatState,
  purgeChatStateExceptLockdown,
  saveChatStateInBackground,
} from "./storage/stateStore";
import {
  botPermissionFetches,
  botPermissionObserver,
  botPermissionProbeBackoff,
  botPermissionRequestTokens,
} from "../cache/main/botAdmin";
import { BOT_PERMISSION_PROBE_RETRY_MS } from "../consts/botAdmin";
import {
  botActionPermissionsEqual,
  botChatPermissionsEqual,
  isAdminStatus,
  readBotChatPermissions,
} from "../libs/chatMember";
import { forgetChatBlocklistWork } from "./blocklist/outbox";
import {
  noteBanPermissionObserved,
  sweepBlockedMembers,
} from "./blocklist/sweep";
import { teardownChatRuntime } from "./chatTeardown";
import type { ChatState } from "../types/chatState";
import type { BotChatPermissions } from "../types/telegram";
import type { ChatMember, ChatMemberUpdated } from "grammy/types";
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "./updateContext";

async function completeAfterTeardown(
  teardown: Promise<void>,
  authoritativeAction: () => Promise<void>,
  failureMessage: string
): Promise<void> {
  const [teardownResult]: [PromiseSettledResult<void>] = await Promise.allSettled([teardown]);
  // 先等 teardown 落定再执行权威动作；teardown 失败时权威动作照常执行，两者的失败合并上抛。
  const [authoritativeResult]: [PromiseSettledResult<void>] = await Promise.allSettled([authoritativeAction()]);
  const failures: unknown[] = [teardownResult, authoritativeResult].flatMap(
    (result: PromiseSettledResult<void>): unknown[] => result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failureMessage);
}

/**
 * 机器人自己在各群的管理员身份追踪。入群守卫（antiRaid）和 /block 以这里的判定做门控。
 * 身份与当前锁定 Bot API 版本的全部权限位一起记在 `ChatState.botPermissions` 里
 * （随 SQLite `chat_states` 持久化）。Bot API 无法枚举机器人所在的群，这份记录同时也是
 * 「/block 在所有管理员群同步生效」的群清单。
 *
 * 维护路径有三条，互为补充：
 * 1. my_chat_member 更新（handleMyChatMemberUpdate）：机器人自己被任免或移出时送达；
 * 2. 收到别人的 chat_member 更新即证明机器人是管理员；快照尚未建立时，
 *    markBotAdminObserved 现查一次完整 ChatMember；
 * 3. 快照缺失的群，首次判定时按需 getChatMember 现查并回填（botChatPermissionsIn）。
 *
 * 三条路径最终都经 recordBotChatPermissions 落盘。确证是管理员时，它还会调用
 * sweepBlockedMembers 补一次 /block 黑名单清扫（是否真扫由 blocklistSweepState 记账
 * 决定）。它只认已 /init enable 的群：my_chat_member 更新不经 infra/updateGate.ts 的
 * isInitEnabled 网关，未初始化的群不写入 `chat_states`。
 */

/**
 * 记录一次确证的完整权限观测，与已知快照不同时才写入、落盘并广播。
 * 未初始化的群（isInitEnabled !== true）不落盘：my_chat_member 更新不经
 * infra/updateGate.ts 的 isInitEnabled 网关，这里用 getChatState（只读）判定，
 * 不经过 getOrCreateChatState，未初始化的群不建 `chat_states` 条目，也不建主线程群状态
 * 热读副本的条目。群后续被 /init enable 后，由 botChatPermissionsIn 的按需回填分支
 * （见本文件顶部注释的第 3 条路径）现查并落盘。
 */
async function recordBotChatPermissions(
  chatId: number,
  permissions: BotChatPermissions
): Promise<void> {
  if (getChatState(chatId).isInitEnabled !== true) return;
  const chatState: ChatState = getOrCreateChatState(chatId);
  const previous: BotChatPermissions | undefined = chatState.botPermissions;
  const changed: boolean = !botChatPermissionsEqual(previous, permissions);
  botPermissionProbeBackoff.delete(chatId);
  if (changed) {
    chatState.botPermissions = permissions;
    // 不再是管理员：这个群欠的那次清扫作废，在途批次一并丢弃，重新拿到权限后重新欠一次。
    // 先于 persistChatState 执行，与 handleMyChatMemberUpdate 的离群路径同序。
    if (!permissions.isAdministrator) forgetChatBlocklistWork(chatId);
    await persistChatState(chatId, "bot permissions refresh");
    // 落盘用完整快照；广播只比较动作权限位（见 libs/chatMember.ts 的 botActionPermissionsEqual），
    // 动作权限位未变时不广播。
    // `previous` 即上一次广播过的值：状态的每一次变更都经本函数或
    // forgetBotChatPermissions（后者广播 undefined 并把快照清成 undefined）。
    if (!botActionPermissionsEqual(previous, permissions)) {
      notifyBotPermissionObserver(chatId, permissions);
    }
  }
  if (!permissions.isAdministrator) return;
  // 封禁权限闩锁只由确证快照里的这条解锁边沿解开。
  noteBanPermissionObserved(chatId, permissions.canRestrictMembers);
  // 是管理员且已初始化：补一次黑名单清扫。本函数是三条管理员发现路径的唯一收口，
  // 每次确证身份都调用 sweepBlockedMembers，由它按 blocklistSweepState 记账决定
  // 是否真扫（O(1) 早退）。/init enable 先作废身份记录与清扫进度，随后的重新判定
  // 走回本函数（见 commands/init.ts）。
  // 清扫失败只记日志、不上抛；退避窗口过去后，下一次身份观测再试。
  try {
    await sweepBlockedMembers(chatId);
  } catch (error: unknown) {
    logger.error(`Failed to sweep blocklisted members from chat ${chatId} after gaining admin rights:`, error);
  }
}

/**
 * 处理 my_chat_member 更新（机器人自己在某个聊天里的成员状态变化）：
 * 被授予/撤销管理员、任一权限开关改变或被移出群聊时，刷新本群的完整权限快照。这类更新
 * 必须显式列进 allowed_updates（`TELEGRAM_ALLOWED_UPDATES`）才会送达。
 * 非管理员 -> 管理员的那一跳会经 recordBotChatPermissions 触发一次黑名单清扫。
 */
export async function handleMyChatMemberUpdate(ctx: Context): Promise<void> {
  const update: ChatMemberUpdated | undefined = ctx.myChatMember;
  if (!update) return;
  // 私聊没有管理员概念，频道里机器人不做任何守卫/踢人，都不记录。
  if (update.chat.type !== "group" && update.chat.type !== "supergroup") return;
  if (update.new_chat_member.status === "left" || update.new_chat_member.status === "kicked") {
    // 机器人已不在群内，权限位作废；重新入群后走按需现查重建。
    forgetBotChatPermissions(update.chat.id);
    // reason 为 `departed`：本群的 AI 记忆、`/wed` 成员集合、入群日志与问答一并删除
    // （见 libs/chatTeardown.ts 的 purgesChatData）；被撤管理员的路径用 `lostAuthority`，不删数据。
    await completeAfterTeardown(
      teardownChatRuntime(update.chat.id, "departed"),
      async (): Promise<void> => {
        // 清除除 lockdown 之外的群状态；lockdown 尚未恢复时保留其 write-ahead owner。
        forgetChatBlocklistWork(update.chat.id);
        purgeChatStateExceptLockdown(update.chat.id);
        await persistChatState(
          update.chat.id,
          `chat ${update.chat.id} state pruned after bot left/kicked`
        );
      },
      `Failed to complete departure transition for chat ${update.chat.id}.`
    );
    return;
  }
  const wasAdmin: boolean = isAdminStatus(update.old_chat_member.status);
  const permissions: BotChatPermissions = readBotChatPermissions(update.new_chat_member);
  if (wasAdmin && !permissions.isAdministrator) {
    await completeAfterTeardown(
      teardownChatRuntime(update.chat.id, "lostAuthority"),
      (): Promise<void> => recordBotChatPermissions(update.chat.id, permissions),
      `Failed to complete admin downgrade transition for chat ${update.chat.id}.`
    );
    return;
  }
  // 权限开关被改动（仍是管理员）同样以 my_chat_member 送达，
  // 这条路径是权限快照的近实时维护点。
  await recordBotChatPermissions(update.chat.id, permissions);
}

/**
 * 现查闸：放行时就地武装退避窗口并返回 true，退避期内返回 false。
 *
 * `getChatMember` 未能确证权限位时，`botChatPermissionsIn` 不落快照（见它的 @returns）；
 * 因快照缺失而在后台现查的入口须先过这道闸。调用方是 markBotAdminObserved。
 */
function admitBotPermissionProbe(chatId: number): boolean {
  const observedAt: number = Date.now();
  const retryAt: number | undefined = botPermissionProbeBackoff.get(chatId);
  if (retryAt !== undefined && observedAt < retryAt) return false;
  botPermissionProbeBackoff.set(chatId, observedAt + BOT_PERMISSION_PROBE_RETRY_MS);
  return true;
}

/**
 * 收到一条别人的 chat_member 更新即证明机器人此刻是该群管理员（Telegram
 * 只向管理员机器人推送这类更新）。已有完整管理员快照时只复用它补一次黑名单清扫；缺失或
 * 与这条事实冲突时才现查机器人自身的完整 ChatMember，不把一个不完整的
 * 「是管理员」布尔值写回 State。
 *
 * 现查先过退避闸（admitBotPermissionProbe），退避期内直接返回，下游读到的仍是「未知」。
 *
 * 现查不 await：本条 update 不等 getChatMember 往返与 durable 落盘
 * （app/updateRunner.ts 严格串行）。这一轮读到的仍是「未知」，快照到达后由下一条更新读到。
 */
export async function markBotAdminObserved(chatId: number): Promise<void> {
  const known: BotChatPermissions | undefined = getChatState(chatId).botPermissions;
  if (known?.isAdministrator === true) {
    // 复用缓存快照，不是新的确证权限观测：只补一次黑名单清扫，不调用
    // noteBanPermissionObserved；封禁权限闩锁只由 my_chat_member 或现查得到的快照解开。
    try {
      await sweepBlockedMembers(chatId);
    } catch (error: unknown) {
      logger.error(`Failed to sweep blocklisted members from chat ${chatId} after an admin observation:`, error);
    }
    return;
  }
  // 先 forgetBotChatPermissions 再过退避闸：前者会清掉退避窗口。陈旧快照只 forget 一次，
  // 此后 known 恒为 undefined，退避闸持续生效。
  if (known !== undefined) forgetBotChatPermissions(chatId);
  if (!admitBotPermissionProbe(chatId)) return;
  // 不 await：本函数的调用点（antiRaid/updateIngress.ts 的 handleChatMemberUpdate）
  // 此后只读 isAntiRaidEnabled 与成员状态，且这条路径不做管理员门控。Worker 侧处置
  // 只对确证的 false 短路，未知照常尝试，由 Telegram 裁决（见 workers/antiRaid/botPermissions.ts）。
  void botChatPermissionsIn(chatId).catch((): void => {
    // 现查内部已记日志；这里吞掉 rejection（update 取消时以 abort 形式抛出）。
    // 落盘失败同样止步于此：写入仍留在 unacknowledgedChatStateWrites 等待
    // flush 或 Worker 重建重放，落盘故障由 Disk I/O 的 fatal 通道处理。
  });
}

/**
 * /init 开关的边界上把持久值恢复为“未知”，并废弃切换前的在途
 * getChatMember。下一次真正需要权限时必须重新向 Telegram 查询。
 */
export function invalidateBotAdminStatus(chatId: number): void {
  forgetBotChatPermissions(chatId);
  // 该群的黑名单清扫进度作废、在途批次一并丢弃，由 enable 之后的重新判定再触发清扫。
  forgetChatBlocklistWork(chatId);
}

/**
 * 同步读取已经观测到的管理员身份。
 *
 * `undefined` 表示权限快照尚未记录，调用方自行决定是否调用
 * `resolveBotAdminStatus` 现查；不得把未知折算成 false。用于每条群消息的
 * ingress，直接读 ChatState 里的快照，不分配 Promise。
 */
export function cachedBotAdminStatus(chatId: number): boolean | undefined {
  return getChatState(chatId).botPermissions?.isAdministrator;
}

/**
 * 机器人在某群是否为管理员。身份不另走一套查询与缓存：直接复用
 * `botChatPermissionsIn` 的完整快照，未知/查询失败时 fail closed 为 false。
 */
export async function resolveBotAdminStatus(chatId: number): Promise<boolean> {
  const permissions: BotChatPermissions | undefined = await botChatPermissionsIn(chatId);
  return permissions?.isAdministrator === true;
}

/**
 * 丢掉某个群的权限位记录，并作废此刻仍在途的那次现查。
 *
 * 删除当前请求令牌与 fetch：旧请求返回后令牌不匹配，不回填；之后的第一次判定
 * 另发新请求。令牌在调用 Telegram 前同步登记。
 */
export function forgetBotChatPermissions(chatId: number): void {
  const had: boolean = getChatState(chatId).botPermissions !== undefined;
  clearChatStateField(chatId, "botPermissions");
  botPermissionProbeBackoff.delete(chatId);
  botPermissionRequestTokens.delete(chatId);
  botPermissionFetches.delete(chatId);
  // 下面两步只在确实丢掉了一份已知值时执行（teardown 路径会对同一个群反复调用）。
  if (!had) return;
  // botPermissions 是持久字段，清除后同样写盘。用后台写，不走 persistChatState，
  // 不插 flush barrier；离群与 /init 两条路径随后自行 persistChatState。
  saveChatStateInBackground(chatId, "bot permissions forgotten");
  notifyBotPermissionObserver(chatId, undefined);
}

/**
 * 登记权限位变化的下游观察者（当前是 Anti-Raid Worker 的投递口）。
 *
 * 反向注册：infra 不静态依赖 Anti-Raid 业务模块（见 docs/cn/04-invariants.md），
 * 与 `registerChatTeardown` 同一形态。单槽位，重复注册以最后一次为准。
 */
export function registerBotPermissionObserver(
  observe: (chatId: number, permissions: BotChatPermissions | undefined) => void
): void {
  botPermissionObserver.current = observe;
}

/**
 * 广播一次权限位变化。观察者是反向注册的单槽位（见 cache/main/botAdmin.ts）：
 * 没人注册时是 no-op，注册方抛错只记日志、不上抛。
 */
function notifyBotPermissionObserver(chatId: number, permissions: BotChatPermissions | undefined): void {
  try {
    botPermissionObserver.current?.(chatId, permissions);
  } catch (error: unknown) {
    logger.error(`Failed to publish the bot's permission change for chat ${chatId}:`, error);
  }
}

/**
 * 同步读取主线程已观测到的删消息权限。`undefined` 表示未知，调用方让
 * Telegram 作为最终裁判；只有明确的 `false` 才跳过删除请求。
 */
export function botCanDeleteMessagesIn(chatId: number): boolean | undefined {
  return getChatState(chatId).botPermissions?.canDeleteMessages;
}

/**
 * 同步读取主线程已观测到的「限制与封禁成员」权限。`undefined` 表示未知，调用方
 * 让 Telegram 作为最终裁判；只有明确的 `false` 才跳过封禁请求。
 */
export function botCanRestrictMembersIn(chatId: number): boolean | undefined {
  return getChatState(chatId).botPermissions?.canRestrictMembers;
}

/**
 * 机器人在某群持有的完整管理员权限。已记录的群同步命中；从未记录过的
 * 群现查一次 getChatMember 并回填（带在途去重，同群并发判定共享同一次请求）。
 *
 * 供踢人、禁言、删消息先判权限再调用 Telegram：缺权限与「目标本身是管理员」共用
 * 400 `not enough rights`（见 infra/telegram/actions/core.ts 的 isPermissionDenied 与
 * actions/moderation.ts 的 banChatMemberWithOutcome）。快照缺失的群才现查，此后由
 * my_chat_member 维护。
 * @returns 确证的完整权限快照；现查失败或结果已被失效作废时为 undefined。
 *   已确证不是管理员也返回一份全权限 false 快照，不与未知混用。
 *   调用方把 undefined 当作「这个动作现在做不了」，不得折算成有权限。
 */
export async function botChatPermissionsIn(chatId: number): Promise<BotChatPermissions | undefined> {
  const known: BotChatPermissions | undefined = getChatState(chatId).botPermissions;
  if (known !== undefined) return known;

  const pending: Promise<BotChatPermissions | undefined> | undefined = botPermissionFetches.get(chatId);
  if (pending !== undefined) return pending;

  // 令牌早于任何 await 登记，是 forgetBotChatPermissions 判断现查是否在途的依据。
  const requestToken: symbol = Symbol(`bot-permissions:${chatId}`);
  botPermissionRequestTokens.set(chatId, requestToken);
  const signal: AbortSignal | undefined = currentUpdateAbortSignal();
  const request: Promise<BotChatPermissions | undefined> = (async (): Promise<BotChatPermissions | undefined> => {
    let member: ChatMember;
    try {
      member = await bot.api.getChatMember(chatId, bot.botInfo.id, telegramSignal(signal));
    } catch (error: unknown) {
      // update 已被取消时不记日志、原样上抛，与其余 Telegram 调用同一约定。
      throwIfUpdateAborted(signal);
      logger.error(`Failed to read the bot's own permissions in chat ${chatId}:`, error);
      return undefined;
    }
    // 请求期间发生过失效（令牌已换）：这份结果既不回填也不返回，调用方下次需要时再发起现查。
    if (botPermissionRequestTokens.get(chatId) !== requestToken) return undefined;
    // 现查在途期间 my_chat_member 已写入快照：以该权威快照为准，不回填这次响应。
    const authoritative: BotChatPermissions | undefined = getChatState(chatId).botPermissions;
    if (authoritative !== undefined) return authoritative;
    const permissions: BotChatPermissions = readBotChatPermissions(member);
    // 「未 /init enable 的群不创建 State」由 recordBotChatPermissions 首行把守，这里不重复判定。
    // 落盘失败不被上面的 Telegram API catch 折算成未知。
    await recordBotChatPermissions(chatId, permissions);
    return permissions;
  })();
  const tracked: Promise<BotChatPermissions | undefined> = request.finally((): void => {
    if (botPermissionFetches.get(chatId) === tracked) botPermissionFetches.delete(chatId);
    if (botPermissionRequestTokens.get(chatId) === requestToken) {
      botPermissionRequestTokens.delete(chatId);
    }
  });
  // 令牌已被同步失效换掉时，不登记旧请求的 fetch。
  if (botPermissionRequestTokens.get(chatId) === requestToken) {
    botPermissionFetches.set(chatId, tracked);
  }
  return tracked;
}
