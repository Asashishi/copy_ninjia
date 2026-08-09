import type { Context } from "grammy";
import { logger } from "./logger";
import { bot } from "./telegram/mainClient";
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
  botChatPermissions,
  botPermissionFetches,
  botPermissionInvalidations,
  botPermissionObserver,
  botPermissionProbeBackoff,
} from "../cache/main/botAdmin";
import { BOT_PERMISSION_PROBE_RETRY_MS } from "../consts/botAdmin";
import { isAdminStatus, readBotChatPermissions } from "../libs/chatMember";
import { forgetChatBlocklistWork } from "./blocklist/outbox";
import {
  noteBanPermissionObserved,
  sweepBlockedMembers,
} from "./blocklist/sweep";
import { teardownRegisteredChat } from "./chatTeardown";
import type { ChatState } from "../types/chatState";
import type { BotChatPermissions } from "../types/telegram";
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
  const gagTeardown: Promise<void> = teardownRegisteredChat("gag", chatId);
  clearChatStateField(chatId, "isProxySendEnabled");
  const aiTeardown: Promise<void> = teardownRegisteredChat("aiChat", chatId);
  const antiRaidTeardown: Promise<void> = teardownRegisteredChat("antiRaid", chatId);
  const results: PromiseSettledResult<void>[] = await Promise.allSettled([
    copyTeardown,
    gagTeardown,
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
 *    时按需 getChatMember 现查一次并回填（resolveBotAdminStatus）。
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
 * 条目都不建。群后续被 /init enable 后，resolveBotAdminStatus 的按需回填分支
 * （见本文件顶部注释的第 3 条路径）会在真正需要时现查一次并正确落盘，
 * 这里的省略不损失任何信息。
 */
async function recordBotAdminStatus(
  chatId: number,
  isAdmin: boolean,
  permissions?: BotChatPermissions
): Promise<void> {
  if (getChatState(chatId).isInitEnabled !== true) return;
  const chatState: ChatState = getOrCreateChatState(chatId);
  if (chatState.botIsAdmin !== isAdmin) {
    chatState.botIsAdmin = isAdmin;
    // 不再是管理员：这个群欠的那次清扫作废，在途批次一并丢弃（继续在一个
    // 已经放手的群里封人是越权），重新拿到权限后重新欠一次。
    //
    // 必须排在落盘**之前**（与下面离群那一路同序）：停管是 Telegram 已经告知的
    // 权威事实，它不会因为 state.json 没写成而撤销。放在落盘之后的话，一旦
    // persistAuthoritativeState 拒绝（StateStore 重试耗尽、或解码校验失败），这一
    // 行根本不执行、进程随即退出，而 state.json 里 botIsAdmin 还是 true——启动
    // 恢复那道 `botIsAdmin !== true` 过滤同样兜不住，那批注定失败的处置会在每次
    // 重启和每次 Worker 重建时原样重投，白占 outbox 容量并无休止地刷错误日志。
    if (!isAdmin) forgetChatBlocklistWork(chatId);
    await persistAuthoritativeState("bot admin status refresh");
  }
  if (!isAdmin) {
    // 不再是管理员就一个权限位都不剩了。留着旧记录会让禁言/删消息这类判定
    // 拿着一份已经作废的快照放行，白打一串注定 403 的请求。
    forgetBotChatPermissions(chatId);
    return;
  }
  // 被权限卡住的群只认这一条解锁边沿：Telegram 亲口说「现在能封人了」。
  // permissions 为 undefined 表示本次观测拿不到权限位（比如收到别人的
  // chat_member 更新那一路只能推出「我是管理员」），保持卡住不动，也不写缓存
  // ——「没观测到」与「观测到没有」必须可区分。
  if (permissions !== undefined) {
    publishBotChatPermissions(chatId, permissions);
    noteBanPermissionObserved(chatId, permissions.canRestrictMembers);
  }
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
    // 人都不在这个群了，权限位当场作废；重新入群走按需现查重建。
    forgetBotChatPermissions(update.chat.id);
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
  // 权限开关被改动（仍是管理员、只是少勾了一项）同样以 my_chat_member 送达，
  // 这条路径因此也是权限缓存的近实时维护点，不只是身份记录。
  await recordBotAdminStatus(update.chat.id, isAdmin, readBotChatPermissions(update.new_chat_member));
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
  forgetBotChatPermissions(chatId);
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
export async function resolveBotAdminStatus(chatId: number): Promise<boolean> {
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
      // catch 只罩着这一次 getChatMember。罩住下面那段的话，
      // recordBotAdminStatus 里 persistAuthoritativeState 的 rejection 会被一起
      // 折算成「不是管理员」：Telegram 侧明明查到了管理员身份，只是状态没写进
      // 硬盘，调用方却按非管理员早退——这一批 new_chat_members 不开验证窗口、不
      // 被消息跟踪、超时也不踢，一整批刷群就这么走进来了；`/block` 同时回一句
      // 「本天才连一个群的管理员都不是」并跳过本群封禁。而唯一的诊断把锅指向
      // Telegram API，下一次调用又从内存里读到 true，现象根本复现不了。
      // 落盘失败按不变量是 fatal durability failure（见 docs/cn/04-invariants.md），
      // 必须原样上抛：这条 update 不能被确认。
      .catch((error: unknown): null => {
        throwIfUpdateAborted(signal);
        logger.error(`Failed to check bot's own admin status in chat ${chatId}:`, error);
        return null;
      })
      .then(async (member: ChatMember | null): Promise<boolean> => {
        // 现查失败按「不是管理员」处理（fail closed），且不落盘——下次照常重查。
        if (member === null) return false;
        // /init 在请求期间切换过：这个响应属于旧一代，不回填，
        // 改用新一代的查询结果。
        if ((botAdminGenerations.get(chatId) ?? 0) !== generation) {
          return resolveBotAdminStatus(chatId);
        }
        const currentKnown: boolean | undefined = getChatState(chatId).botIsAdmin;
        if (currentKnown !== undefined) return currentKnown;
        const isAdmin: boolean = isAdminStatus(member.status);
        await recordBotAdminStatus(chatId, isAdmin, readBotChatPermissions(member));
        return isAdmin;
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

/**
 * 丢掉某个群的权限位记录，并作废此刻仍在途的那次现查。
 *
 * 在途时把那次现查标成已作废而不是只删缓存：请求发出时看到的还是旧身份，等它
 * 回来直接回填，就会把刚被撤掉的权限重新写回表里。「有没有在途」看的是
 * botPermissionInvalidations 的条目而不是 botPermissionFetches——后者要等请求真的
 * 挂起才登记得上，而作废标记是在发请求之前同步占的位，两者之间那一小段里到达的
 * 失效不能漏掉。没有在途请求时这个标记没有读者，保持删除状态，免得这张表随历史
 * 群无限增长。
 */
export function forgetBotChatPermissions(chatId: number): void {
  const had: boolean = botChatPermissions.delete(chatId);
  botPermissionProbeBackoff.delete(chatId);
  if (botPermissionInvalidations.has(chatId)) botPermissionInvalidations.set(chatId, true);
  // 只在真的丢掉了一份已知值时广播「现在未知」：teardown 路径会对同一个群
  // 反复调用，无条件广播就是往 Worker mailbox 里灌重复消息。
  if (had) notifyBotPermissionObserver(chatId, undefined);
}

/**
 * 登记权限位变化的下游观察者（当前是 Anti-Raid Worker 的投递口）。
 *
 * 反向注册而不是直接 import：infra 不得静态依赖 Anti-Raid 业务模块
 * （见 docs/cn/04-invariants.md），与 `registerChatTeardown` 同一形态。单槽位，
 * 重复注册以最后一次为准。
 */
export function registerBotPermissionObserver(
  observe: (chatId: number, permissions: BotChatPermissions | undefined) => void
): void {
  botPermissionObserver.current = observe;
}

/** 写入一份确证的权限位并广播给下游（当前是 Anti-Raid Worker）。 */
function publishBotChatPermissions(chatId: number, permissions: BotChatPermissions): void {
  botPermissionProbeBackoff.delete(chatId);
  const previous: BotChatPermissions | undefined = botChatPermissions.get(chatId);
  botChatPermissions.set(chatId, permissions);
  // 逐位相同就不广播：`my_chat_member` 会为任何一次成员变动送达（改群名片、
  // 换自定义头衔都算），每次都往 Worker mailbox 里塞一条一模一样的消息没有意义。
  if (
    previous?.canRestrictMembers === permissions.canRestrictMembers &&
    previous?.canDeleteMessages === permissions.canDeleteMessages
  ) {
    return;
  }
  notifyBotPermissionObserver(chatId, permissions);
}

/**
 * 广播一次权限位变化。观察者是反向注册的单槽位（见 cache/main/botAdmin.ts）：
 * 没人注册时是 no-op，注册方抛错也只记日志——权限记录本身已经更新，不能因为
 * 下游投递失败把整条 update 判成失败。
 */
function notifyBotPermissionObserver(chatId: number, permissions: BotChatPermissions | undefined): void {
  try {
    botPermissionObserver.current?.(chatId, permissions);
  } catch (error: unknown) {
    logger.error(`Failed to publish the bot's permission change for chat ${chatId}:`, error);
  }
}

/**
 * 保证这个群的权限位已经被观测过一次，供热路径在不 await 的前提下调用。
 *
 * 已知（缓存命中）或已有现查在途时立即返回，因此稳定状态下就是一次 Map 查找。
 * 只有从未观测过的群才在后台现查一次，结果经上面的广播抵达 Worker。**必须带
 * 退避**：`state.json` 记着是管理员而实际已经不是、或 `getChatMember` 持续失败
 * 时，`botChatPermissionsIn` 按约定不落缓存，没有退避就等于那种群里每条消息
 * 都换一次注定失败的现查。
 */
export function ensureBotChatPermissions(chatId: number, now?: number): void {
  if (botChatPermissions.has(chatId) || botPermissionInvalidations.has(chatId)) return;
  // 取钟必须留在早退之后。`now: number = Date.now()` 那种写法由 JSC 在函数
  // prologue 里求值，也就是**缓存命中的那条路也照付一次 Date.now()**，而它紧接着
  // 就被上面那行 return 丢掉。稳定状态下这个函数每条群消息都跑、且几乎总是命中，
  // 实测热路径 55~63 ns/op 里约 98% 就是这次白取的钟（改成惰性后 0.75~1.13）。
  // 调用方注入的值仍然原样生效，退避语义不变。
  const observedAt: number = now ?? Date.now();
  const retryAt: number | undefined = botPermissionProbeBackoff.get(chatId);
  if (retryAt !== undefined && observedAt < retryAt) return;
  botPermissionProbeBackoff.set(chatId, observedAt + BOT_PERMISSION_PROBE_RETRY_MS);
  void botChatPermissionsIn(chatId).catch((): void => {
    // 现查内部已经记过日志；这里只是不让后台补齐变成未处理的 rejection
    // （update 取消时它会以 abort 形式抛出）。
  });
}

/**
 * 同步读取主线程已经观测到的删消息权限。`undefined` 只表示未知，调用方可以让
 * Telegram 作为最终裁判；只有明确的 `false` 才适合跳过注定失败的删除请求。
 */
export function botCanDeleteMessagesIn(chatId: number): boolean | undefined {
  return botChatPermissions.get(chatId)?.canDeleteMessages;
}

/**
 * 机器人在某群持有的破坏性动作权限位。已记录的群直接同步命中；从未记录过的
 * 群现查一次 getChatMember 并回填（带在途去重，同群并发判定共享同一次请求）。
 *
 * 存在的理由是**先判后打**：踢人、禁言、删消息在缺权限时都只换回一句 400
 * `not enough rights`，而那句话与「目标本身是管理员」共用同一个错误码，事后
 * 看日志分不开（见 infra/telegram/actions.ts 的 banChatMemberWithOutcome）。
 * 有了这份缓存，绝大多数判定是一次 Map 查找，只有进程刚起来、还没收到过任何
 * my_chat_member 的群才付一次现查——此后由 my_chat_member 近实时维护。
 * @returns 确证的权限位；不是管理员、现查失败或结果已被失效作废时为 undefined。
 *   调用方一律把 undefined 当作「这个动作现在做不了」，不得折算成有权限。
 */
export async function botChatPermissionsIn(chatId: number): Promise<BotChatPermissions | undefined> {
  const known: BotChatPermissions | undefined = botChatPermissions.get(chatId);
  if (known !== undefined) return known;

  const pending: Promise<BotChatPermissions | undefined> | undefined = botPermissionFetches.get(chatId);
  if (pending !== undefined) return pending;

  // 占位必须早于任何 await：它同时是 forgetBotChatPermissions 判断「有没有
  // 现查在途」的唯一依据，晚一步登记就会漏掉这段窗口里到达的失效。
  botPermissionInvalidations.set(chatId, false);
  const signal: AbortSignal | undefined = currentUpdateAbortSignal();
  const request: Promise<BotChatPermissions | undefined> = (async (): Promise<BotChatPermissions | undefined> => {
    let member: ChatMember;
    try {
      member = signal === undefined
        ? await bot.api.getChatMember(chatId, bot.botInfo.id)
        : await bot.api.getChatMember(
          chatId,
          bot.botInfo.id,
          signal as unknown as Parameters<typeof bot.api.getChatMember>[2]
        );
    } catch (error: unknown) {
      // update 已被取消时不记日志、原样上抛，与其余 Telegram 调用同一约定。
      throwIfUpdateAborted(signal);
      logger.error(`Failed to read the bot's own permissions in chat ${chatId}:`, error);
      return undefined;
    }
    // 失效发生在请求期间：这份快照描述的是失效前的身份，既不回填也不作数。
    // 不在这里重新发起——递归会撞上下面那次 finally 之前的自引用；调用方下一次
    // 需要时自然会开一次新的现查。
    if (botPermissionInvalidations.get(chatId) !== false) return undefined;
    // 现查在途期间 my_chat_member 先一步落地过：那条是权威信号，而这次响应
    // 反映的可能是它到达之前的旧快照，直接回填会把刚生效的权限改动顶掉。
    // 同 resolveBotAdminStatus 的「权威信号已经赢了就采用它」。
    const authoritative: BotChatPermissions | undefined = botChatPermissions.get(chatId);
    if (authoritative !== undefined) return authoritative;
    if (!isAdminStatus(member.status)) {
      // 走 forget 而不是裸 delete：连同在途现查的作废与下游广播一起收敛在一处。
      forgetBotChatPermissions(chatId);
      // 「其实已经不是管理员」是一次权威身份观测，写回去纠正 state.json 里过期的
      // botIsAdmin: true（进程停机期间被撤管理员时收不到 my_chat_member，那份 true
      // 会一直留着）。不写的话 resolveBotAdminStatus 每条群消息都放行、每条都重新走到这里。
      await recordBotAdminStatus(chatId, false);
      // 退避必须**最后**钉上：上面两步都会清掉它——forget 收敛的是「权威信号刚到、
      // 该立刻重新观测」那一路，而这次的结论恰好相反，刚探测完、确认没权限。顺序
      // 反了就等于这次探测把自己的退避擦掉，5 分钟一次退化成每条消息一次；未
      // /init enable 的群 recordBotAdminStatus 直接早退，退避更是唯一的节流。
      botPermissionProbeBackoff.set(chatId, Date.now() + BOT_PERMISSION_PROBE_RETRY_MS);
      return undefined;
    }
    const permissions: BotChatPermissions = readBotChatPermissions(member);
    // 与 recordBotAdminStatus 同一条门禁：没 /init enable 的群不留内存条目，
    // 免得光是被拉进一堆群就长出一张表。
    if (getChatState(chatId).isInitEnabled === true) publishBotChatPermissions(chatId, permissions);
    return permissions;
  })();
  const tracked: Promise<BotChatPermissions | undefined> = request.finally((): void => {
    if (botPermissionFetches.get(chatId) !== tracked) return;
    botPermissionFetches.delete(chatId);
    // 作废标记只服务于在途请求；这次已经结算，留着只是让表随历史群增长。
    botPermissionInvalidations.delete(chatId);
  });
  botPermissionFetches.set(chatId, tracked);
  return tracked;
}
