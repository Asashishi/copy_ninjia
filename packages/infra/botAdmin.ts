import type { Context } from "grammy";
import { logger } from "./logger";
import { bot } from "./telegram";
import {
  clearChatStateField,
  getChatState,
  getOrCreateChatState,
  persistAuthoritativeState,
  pruneDepartedChatState,
} from "./storage/stateStore";
import {
  botAdminFetches,
  botAdminGenerations,
  botAdminGenerationUsers,
} from "../cache/botAdmin";
import { isAdminStatus } from "../libs/chatMember";
import { forgetChatBlocklistWork, sweepBlockedMembers } from "./blocklist";
import { teardownRegisteredChat } from "./chatTeardown";
import type { ChatState } from "../types/chatState";
import type { ChatMember, ChatMemberUpdated } from "@grammyjs/types";
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
  // Anti-Raid teardown 可能仍在恢复群权限，必须等它落定后才能裁剪 owner；
  // teardown 失败也不能跳过后续权威状态收敛。
  const [authoritativeResult]: [PromiseSettledResult<void>] = await Promise.allSettled([authoritativeAction()]);
  const failures: unknown[] = [teardownResult, authoritativeResult].flatMap(
    (result: PromiseSettledResult<void>): unknown[] => result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failureMessage);
}

/** 配置去留由调用入口决定；这里只停止 owner、取消计时器并发起权限恢复。 */
export async function teardownChatRuntime(chatId: number): Promise<void> {
  // 先同步调用全部 owner，让跨群 copy 槽、代理入口和 Worker 闸门在第一个
  // await 之前一起关闭；随后等待需要 durable 回执的异步 owner。
  const copyTeardown: Promise<void> = teardownRegisteredChat("copy", chatId);
  clearChatStateField(chatId, "isProxySendEnabled");
  const aiTeardown: Promise<void> = teardownRegisteredChat("aiChat", chatId);
  const antiRaidTeardown: Promise<void> = teardownRegisteredChat("antiRaid", chatId);
  const results: PromiseSettledResult<void>[] = await Promise.allSettled([
    copyTeardown,
    aiTeardown,
    antiRaidTeardown,
  ]);
  const failures: unknown[] = results.flatMap(
    (result: PromiseSettledResult<void>): unknown[] => result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, `Chat runtime teardown failed for chat ${chatId}.`);
  }
}

/**
 * 机器人自己在各群的管理员身份追踪。入群守卫（antiRaid）和 /block 都需要
 * 管理员权限才有意义：不是管理员时收不到别人的 chat_member 更新、踢不了人
 * 也删不了消息，硬跑只会刷一堆注定失败的 API 报错——所以这两处都以这里的
 * 判定做门控。身份记在各群的 ChatState.botIsAdmin 里（随 state.json 持久
 * 化）：Bot API 无法枚举机器人所在的群，这份记录同时也是「/block 在所有
 * 管理员群同步生效」的群清单，必须落盘才能跨重启存活。
 *
 * 维护路径有三条，互为补充：
 * 1. my_chat_member 更新（handleMyChatMemberUpdate）——机器人自己被任免/
 *    移出时 Telegram 必发，近实时且权威；
 * 2. 收到别人的 chat_member 更新本身就是管理员身份的证明（Telegram 只向
 *    管理员机器人推送），见 markBotAdminObserved，零成本自愈；
 * 3. 两者都没来过的存量群（比如此功能上线前就已是管理员的群），首次判定
 *    时按需 getChatMember 现查一次并回填（isBotAdminIn）。
 *
 * 三条路径最终都经 recordBotAdminStatus 落盘。它同时是「机器人在这个群可以
 * 干活了」这个合取（是管理员 && 已 /init enable）的边沿：任一边发生变更、
 * 合取由不成立变为成立时，在那里补一次 /block 黑名单清扫。它只认已 /init enable 过
 * 的群：my_chat_member 更新会绕过 app/registerHandlers.ts 的 isInitEnabled
 * 网关（机器人被拉进任何群，不管有没有人 /init，Telegram 都会推送），若
 * 不在这里把关，
 * state.json 就会为「只是被拉进去、从没人管过」的群凭空长出条目。
 */

/**
 * 记录一次确证的管理员身份观测结果，与已知值不同时才写入并落盘。
 * 未初始化的群（isInitEnabled !== true）一律不落盘：my_chat_member 更新（机器人
 * 被拉进群/任免管理员）会绕过 app/registerHandlers.ts 的 isInitEnabled 网关
 * 送到这里，若不设防，
 * 光是被拉进一个群、还没人 /init enable，state.json 就会凭空多出一条只有
 * botIsAdmin 的记录——先于任何超级管理员操作自己"写"进去了。用 getChatState
 * （只读）判定，不经过 getOrCreateChatState，未初始化的群连内存里的 Map
 * 条目都不建。群后续被 /init enable 后，isBotAdminIn 的按需回填分支
 * （见本文件顶部注释的第 3 条路径）会在真正需要时现查一次并正确落盘，
 * 这里的省略不损失任何信息。
 */
async function recordBotAdminStatus(chatId: number, isAdmin: boolean): Promise<void> {
  if (getChatState(chatId).isInitEnabled !== true) return;
  const chatState: ChatState = getOrCreateChatState(chatId);
  if (chatState.botIsAdmin !== isAdmin) {
    chatState.botIsAdmin = isAdmin;
    await persistAuthoritativeState("bot admin status refresh");
    // 不再是管理员：这个群欠的那次清扫作废，在途批次一并丢弃（继续在一个
    // 已经放手的群里封人是越权），重新拿到权限后重新欠一次。
    if (!isAdmin) forgetChatBlocklistWork(chatId);
  }
  if (!isAdmin) return;
  // 「是管理员 && 已初始化」成立：补一次黑名单清扫。本函数是三条管理员发现
  // 路径的唯一收口，因此每次确证身份都在这里问一次；「这个群扫过了没有」由
  // sweepBlockedMembers 自己按 blocklistSweepState 记账（O(1) 早退），而不是
  // 由这里的「值变没变」代表——把边沿消耗在投递那一刻，一次限流失败就等于
  // 那些人永久坐在群里。/init enable 那一边的变更同样落到这里：它会先作废
  // 身份记录与清扫进度，随后的重新判定走回本函数（见 commands/init.ts）。
  // 失败只记日志不上抛：管理员身份已经记好了，补扫失败不该把整条 update 判成
  // 失败——退避窗口过去后，下一次身份观测会再试一次。
  try {
    await sweepBlockedMembers(chatId);
  } catch (error: unknown) {
    logger.error(`Failed to sweep blocklisted members from chat ${chatId} after gaining admin rights:`, error);
  }
}

/**
 * 处理 my_chat_member 更新（机器人自己在某个聊天里的成员状态变化）：
 * 被授予/撤销管理员、被移出群聊时刷新本群的 botIsAdmin 记录。这类更新
 * 必须显式列进 allowed_updates 才会送达（见 app/lifecycle.ts）。
 * 非管理员 -> 管理员的那一跳会经 recordBotAdminStatus 触发一次黑名单清扫。
 */
export async function handleMyChatMemberUpdate(ctx: Context): Promise<void> {
  const update: ChatMemberUpdated | undefined = ctx.myChatMember;
  if (!update) return;
  // 私聊没有管理员概念，频道里机器人不做任何守卫/踢人，都不记录。
  if (update.chat.type !== "group" && update.chat.type !== "supergroup") return;
  if (update.new_chat_member.status === "left" || update.new_chat_member.status === "kicked") {
    await completeAfterTeardown(
      teardownChatRuntime(update.chat.id),
      async (): Promise<void> => {
        // 普通配置删除；若 lockdown 尚未恢复则保留 write-ahead owner，避免群权限
        // 因退群而永久卡住。重新入群后 initAntiRaid/Worker 重建会继续接管。
        forgetChatBlocklistWork(update.chat.id);
        pruneDepartedChatState(update.chat.id);
        await persistAuthoritativeState(`chat ${update.chat.id} state pruned after bot left/kicked`);
      },
      `Failed to complete departure transition for chat ${update.chat.id}.`
    );
    return;
  }
  const wasAdmin: boolean = isAdminStatus(update.old_chat_member.status);
  const isAdmin: boolean = isAdminStatus(update.new_chat_member.status);
  if (wasAdmin && !isAdmin) {
    await completeAfterTeardown(
      teardownChatRuntime(update.chat.id),
      (): Promise<void> => recordBotAdminStatus(update.chat.id, false),
      `Failed to complete admin downgrade transition for chat ${update.chat.id}.`
    );
    return;
  }
  await recordBotAdminStatus(update.chat.id, isAdmin);
}

/**
 * 收到一条别人的 chat_member 更新即证明机器人此刻是该群管理员（Telegram
 * 只向管理员机器人推送这类更新），顺手记录，不打任何 API。
 */
export function markBotAdminObserved(chatId: number): Promise<void> {
  return recordBotAdminStatus(chatId, true);
}

/**
 * /init 开关的边界上把持久值恢复为“未知”，并废弃切换前的在途
 * getChatMember。下一次真正需要权限时必须重新向 Telegram 查询。
 */
export function invalidateBotAdminStatus(chatId: number): void {
  if ((botAdminGenerationUsers.get(chatId) ?? 0) > 0) {
    botAdminGenerations.set(chatId, (botAdminGenerations.get(chatId) ?? 0) + 1);
  } else {
    botAdminGenerations.delete(chatId);
  }
  botAdminFetches.delete(chatId);
  clearChatStateField(chatId, "botIsAdmin");
  // /init 一关一开之间机器人可能已经不是管理员、群里也可能换了人：这个群
  // 欠的那次黑名单清扫重新算，由 enable 之后的重新判定再触发一次。在途批次
  // 同时丢弃——被 disable 中断的那批不能在重新接管前继续跑。
  forgetChatBlocklistWork(chatId);
}

/**
 * 机器人在某群是否为管理员。已有记录（无论真假）直接同步返回；从未记录过
 * 的群现查一次 getChatMember 并回填（带在途去重，同群并发判定共享同一次
 * 请求）。现查失败按「不是管理员」处理（fail closed：门控宁可漏跑一次守卫
 * /拒一次 /block，也不带着没权限的身份硬跑），且不落盘——下次照常重查。
 *
 * 现查在途期间，若 my_chat_member/chat_member 的权威信号（本文件顶部注释
 * 的路径 1/2）先一步落地：本地事件处理顺序不保证跟 Telegram 内部时序完全
 * 一致，这次现查的响应可能反映的是权威信号到达前的旧快照——回填前重新读
 * 一次当前值，非 undefined 就说明权威信号已经赢了，直接采用它（不用现查
 * 结果覆盖状态，也把它作为这次调用的返回值，保证跟落盘的状态一致）。
 */
export async function isBotAdminIn(chatId: number): Promise<boolean> {
  const known: boolean | undefined = getChatState(chatId).botIsAdmin;
  if (known !== undefined) return known;

  let inFlight: Promise<boolean> | undefined = botAdminFetches.get(chatId);
  if (!inFlight) {
    const generation: number = botAdminGenerations.get(chatId) ?? 0;
    const signal: AbortSignal | undefined = currentUpdateAbortSignal();
    botAdminGenerationUsers.set(chatId, (botAdminGenerationUsers.get(chatId) ?? 0) + 1);
    const getMember: Promise<ChatMember> = signal === undefined
      ? bot.api.getChatMember(chatId, bot.botInfo.id)
      : bot.api.getChatMember(
        chatId,
        bot.botInfo.id,
        signal as unknown as Parameters<typeof bot.api.getChatMember>[2]
      );
    const request: Promise<boolean> = getMember
      .then(async (member: ChatMember): Promise<boolean> => {
        // /init 在请求期间切换过：这个响应属于旧一代，不回填，
        // 改用新一代的查询结果。
        if ((botAdminGenerations.get(chatId) ?? 0) !== generation) {
          return isBotAdminIn(chatId);
        }
        const currentKnown: boolean | undefined = getChatState(chatId).botIsAdmin;
        if (currentKnown !== undefined) return currentKnown;
        const isAdmin: boolean = isAdminStatus(member.status);
        await recordBotAdminStatus(chatId, isAdmin);
        return isAdmin;
      })
      .catch((error: unknown): boolean => {
        throwIfUpdateAborted(signal);
        logger.error(`Failed to check bot's own admin status in chat ${chatId}:`, error);
        return false;
      })
      .finally((): void => {
        if (botAdminFetches.get(chatId) === request) botAdminFetches.delete(chatId);
        const remainingUsers: number = (botAdminGenerationUsers.get(chatId) ?? 1) - 1;
        if (remainingUsers <= 0) {
          botAdminGenerationUsers.delete(chatId);
          botAdminGenerations.delete(chatId);
        } else {
          botAdminGenerationUsers.set(chatId, remainingUsers);
        }
      });
    inFlight = request;
    botAdminFetches.set(chatId, request);
  }
  return inFlight;
}
