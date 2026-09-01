import type { Context } from "grammy";
import { logger } from "./logger";
import { bot } from "./telegram/mainClient";
import {
  clearChatStateField,
  getChatState,
  getOrCreateChatState,
  persistChatState,
  pruneDepartedChatState,
  saveChatStateInBackground,
} from "./storage/stateStore";
import {
  botPermissionFetches,
  botPermissionObserver,
  botPermissionProbeBackoff,
  botPermissionRequestTokens,
} from "../cache/main/botAdmin";
import { BOT_PERMISSION_PROBE_RETRY_MS } from "../consts/botAdmin";
import { CHAT_TEARDOWN_ORDER } from "../consts/chatTeardown";
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
import { teardownRegisteredChat } from "./chatTeardown";
import type { ChatState } from "../types/chatState";
import type { ChatTeardownReason } from "../types/chatTeardown";
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
export async function teardownChatRuntime(
  chatId: number,
  reason: ChatTeardownReason
): Promise<void> {
  // 先同步调用全部 owner，让跨群 copy 槽、代理入口和 Worker 闸门在第一个
  // await 之前一起关闭；随后等待需要 durable 回执的异步 owner。
  //
  // 遍历 CHAT_TEARDOWN_ORDER 而不是在这里手写 owner 列表：手写过一版，五个里
  // 只写了四个，漏掉的 `qa` 直到全仓审查才被发现。那份顺序表由类型强制穷尽
  // ChatRuntimeOwner（见 consts/chatTeardown.ts），漏一个就编译不过。
  //
  // 代理入口不属于任何 owner 的回调，但同样要在这个同步段里关掉。放在循环前
  // 与放在循环中间等价：整个循环没有 await，且没有任何 owner 的 teardown 读
  // isProxySendEnabled。
  clearChatStateField(chatId, "isProxySendEnabled");
  const teardowns: Promise<void>[] = [];
  for (const owner of CHAT_TEARDOWN_ORDER) {
    teardowns.push(teardownRegisteredChat(owner, chatId, reason));
  }
  const results: PromiseSettledResult<void>[] = await Promise.allSettled(teardowns);
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
 * 判定做门控。身份与当前锁定 Bot API 版本的全部权限位一起记在
 * `ChatState.botPermissions` 里（随 SQLite `chat_states` 持久化）。Bot API 无法枚举机器人
 * 所在的群，这份记录同时也是「/block 在所有管理员群同步生效」的群清单。
 *
 * 维护路径有三条，互为补充：
 * 1. my_chat_member 更新（handleMyChatMemberUpdate）——机器人自己被任免/
 *    移出时 Telegram 必发，近实时且权威；
 * 2. 收到别人的 chat_member 更新本身就证明机器人是管理员；若快照
 *    尚未建立，markBotAdminObserved 会现查一次完整 ChatMember；
 * 3. 两者都没来过的存量群（比如此功能上线前就已是管理员的群），首次判定
 *    时按需 getChatMember 现查一次并回填（resolveBotAdminStatus）。
 *
 * 三条路径最终都经 recordBotChatPermissions 落盘。它同时是「机器人在这个群可以
 * 干活了」这个合取（是管理员 && 已 /init enable）的边沿：任一边发生变更、
 * 合取由不成立变为成立时，在那里补一次 /block 黑名单清扫。它只认已 /init enable 过
 * 的群：my_chat_member 更新会绕过 app/registerHandlers.ts 的 isInitEnabled
 * 网关（机器人被拉进任何群，不管有没有人 /init，Telegram 都会推送），若
 * 不在这里把关，
 * `chat_states` 就会为「只是被拉进去、从没人管过」的群凭空长出条目。
 */

/**
 * 记录一次确证的完整权限观测，与已知快照不同时才写入、落盘并广播。
 * 未初始化的群（isInitEnabled !== true）一律不落盘：my_chat_member 更新（机器人
 * 被拉进群/任免管理员）会绕过 app/registerHandlers.ts 的 isInitEnabled 网关
 * 送到这里，若不设防，
 * 光是被拉进一个群、还没人 /init enable，`chat_states` 就会凭空多出一条只有
 * botPermissions 的记录——先于任何超级管理员操作自己"写"进去了。用 getChatState
 * （只读）判定，不经过 getOrCreateChatState，未初始化的群连主线程 LRU
 * 条目都不建。群后续被 /init enable 后，resolveBotAdminStatus 的按需回填分支
 * （见本文件顶部注释的第 3 条路径）会在真正需要时现查一次并正确落盘，
 * 这里的省略不损失任何信息。
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
    // 不再是管理员：这个群欠的那次清扫作废，在途批次一并丢弃（继续在一个
    // 已经放手的群里封人是越权），重新拿到权限后重新欠一次。
    //
    // 必须排在落盘**之前**（与下面离群那一路同序）：停管是 Telegram 已经告知的
    // 权威事实，它不会因为 SQLite 没写成而撤销。放在落盘之后的话，一旦
    // persistChatState 拒绝（SQLite 事务失败或没有精确 ACK），这一
    // 行根本不执行、进程随即退出，而 `chat_states` 旧行还表示管理员——
    // 启动恢复那道 `isAdministrator !== true` 过滤同样兜不住，那批注定失败的处置会在每次
    // 重启和每次 Worker 重建时原样重投，白占 outbox 容量并无休止地刷错误日志。
    if (!permissions.isAdministrator) forgetChatBlocklistWork(chatId);
    await persistChatState(chatId, "bot permissions refresh");
    // 落盘看**全快照**（那 18 位都要准确存下来），广播只看下游真正读的那两位。
    // my_chat_member 对机器人自身成员记录的任何改动都会送达，因此勾掉一个本仓库
    // 从不读的权限（canPostStories、canManageTags、canChangeInfo、isAnonymous……）
    // 也会走到这里；两位没变时投出去的是一条与上一条逐字节相同的
    // botPermissionsChanged，白占 Worker mailbox。
    // `previous` 就是上一次广播过的值：状态的每一次变更都经本函数或
    // forgetBotChatPermissions（后者广播 undefined 并把快照也清成 undefined），
    // 两边同进同出，不需要另记一份「上次广播了什么」。
    if (!botActionPermissionsEqual(previous, permissions)) {
      notifyBotPermissionObserver(chatId, permissions);
    }
  }
  if (!permissions.isAdministrator) return;
  // 被权限卡住的群只认确证快照里的这条解锁边沿。
  noteBanPermissionObserved(chatId, permissions.canRestrictMembers);
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
 * 被授予/撤销管理员、任一权限开关改变或被移出群聊时，刷新本群的完整权限快照。这类更新
 * 必须显式列进 allowed_updates 才会送达（见 app/lifecycle.ts）。
 * 非管理员 -> 管理员的那一跳会经 recordBotChatPermissions 触发一次黑名单清扫。
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
      teardownChatRuntime(update.chat.id, "lostAuthority"),
      async (): Promise<void> => {
        // 普通配置删除；若 lockdown 尚未恢复则保留 write-ahead owner，避免群权限
        // 因退群而永久卡住。重新入群后 initAntiRaid/Worker 重建会继续接管。
        forgetChatBlocklistWork(update.chat.id);
        pruneDepartedChatState(update.chat.id);
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
  // 权限开关被改动（仍是管理员、只是少勾了一项）同样以 my_chat_member 送达，
  // 这条路径因此是 State 权限快照的近实时唯一维护点。
  await recordBotChatPermissions(update.chat.id, permissions);
}

/**
 * 现查闸：放行时就地武装退避窗口并返回 true，退避期内返回 false。
 *
 * `getChatMember` 一次没能确证权限位之后，`botChatPermissionsIn` 按约定不落任何
 * 快照（见它的 @returns）。因此**每一处会因「快照缺失」而现查的入口都必须先过这道
 * 闸**，否则那种群里每一条触发它的更新都换一次注定失败的现查。目前是两处：热路径的
 * 按需补齐（ensureBotChatPermissions）与入群洪流上的身份观测（markBotAdminObserved）。
 *
 * 取钟保持惰性：调用方早退时不得执行 Date.now()。调用方注入的值原样生效，
 * 退避语义不变。
 */
function admitBotPermissionProbe(chatId: number, now?: number): boolean {
  const observedAt: number = now ?? Date.now();
  const retryAt: number | undefined = botPermissionProbeBackoff.get(chatId);
  if (retryAt !== undefined && observedAt < retryAt) return false;
  botPermissionProbeBackoff.set(chatId, observedAt + BOT_PERMISSION_PROBE_RETRY_MS);
  return true;
}

/**
 * 收到一条别人的 chat_member 更新即证明机器人此刻是该群管理员（Telegram
 * 只向管理员机器人推送这类更新）。已有完整管理员快照时只复用；缺失或
 * 与这条事实冲突时才现查机器人自身的完整 ChatMember，不把一个不完整的
 * 「是管理员」布尔值写回 State。
 *
 * 现查**必须过退避闸**（admitBotPermissionProbe）。这条路径挂在入群洪流上：
 * 每个新成员一条 chat_member，`getChatMember` 持续失败（429）时
 * `botChatPermissionsIn` 按约定不落任何快照，不设闸就等于按入群速率一条一条地
 * 重发注定失败的现查——正是 BOT_PERMISSION_PROBE_RETRY_MS 要消除的那种放大，
 * 而且发生在唯一必须跑得快的那条路上。退避期内直接返回：本来也拿不到可写的
 * 确证快照，下游读到的仍是「未知」，与现查失败时同义。
 *
 * 现查也**不 await**（同 ensureBotChatPermissions）。它要付一次 getChatMember 往返
 * 外加一次 durable 落盘，而 app/updateRunner.ts 是严格串行的——一条 update 没跑完
 * 就不再 getUpdates——于是冷进程里刷群的第一条 chat_member 会拿这两样把整条
 * ingress 顶住，验证窗口和后面每一条更新一起顺延。既然退避命中时这条路径本来就
 * 「这一轮拿不到快照」照常往下走，晚一拍拿到就是同一种情形，没有理由为它停住 ingress。
 */
export async function markBotAdminObserved(chatId: number): Promise<void> {
  const known: BotChatPermissions | undefined = getChatState(chatId).botPermissions;
  if (known?.isAdministrator === true) {
    await recordBotChatPermissions(chatId, known);
    return;
  }
  // 顺序不能反：forgetBotChatPermissions 会清掉退避窗口（丢掉一份权威值之后本就
  // 该允许立刻重查），先武装再 forget 等于没有闸。陈旧快照只会被 forget 一次，
  // 此后 known 恒为 undefined，闸就一直生效。
  if (known !== undefined) forgetBotChatPermissions(chatId);
  if (!admitBotPermissionProbe(chatId)) return;
  // 这一轮之内没人会读它：本函数的调用点（antiRaid/updateIngress.ts 的
  // handleChatMemberUpdate）此后只读 isAntiRaidEnabled 与成员状态，且这条路径按设计
  // **不做管理员门控**（收得到别人的 chat_member 就证明是管理员）。真正会看权限位的
  // 是 Worker 侧的处置，而那边三个消费点一律只对**确证的 false** 短路，未知照常尝试、
  // 让 Telegram 当裁判（见 workers/antiRaid/botPermissions.ts）——所以晚一拍到达的
  // 镜像不会漏掉任何一次踢人或删消息。
  void botChatPermissionsIn(chatId).catch((): void => {
    // 现查内部已经记过日志；这里只是不让后台补齐变成未处理的 rejection（update
    // 取消时它会以 abort 形式抛出）。落盘失败同样止步于此：那次写仍留在
    // unacknowledgedChatStateWrites 里等下一次 flush 或 Worker 重建重放，而真正的
    // 落盘故障由 Disk I/O 自己的 fatal 通道停机，不靠这条观测路径上抛。
  });
}

/**
 * /init 开关的边界上把持久值恢复为“未知”，并废弃切换前的在途
 * getChatMember。下一次真正需要权限时必须重新向 Telegram 查询。
 */
export function invalidateBotAdminStatus(chatId: number): void {
  forgetBotChatPermissions(chatId);
  // /init 一关一开之间机器人可能已经不是管理员、群里也可能换了人：这个群
  // 欠的那次黑名单清扫重新算，由 enable 之后的重新判定再触发一次。在途批次
  // 同时丢弃——被 disable 中断的那批不能在重新接管前继续跑。
  forgetChatBlocklistWork(chatId);
}

/**
 * 同步读取已经观测到的管理员身份。
 *
 * `undefined` 只表示「本进程还没确证过这个群」，调用方自行决定是否付一次
 * `resolveBotAdminStatus` 的现查；不得把未知折算成 false。存在的理由是每条群
 * 消息的 ingress：稳定态下这个群的权限快照早就在 ChatState 里，走
 * `resolveBotAdminStatus` 只是为了一个已经在手的布尔值分配一个 Promise
 * （形状约束见 AGENTS.md「高频路径可直接读取现值时不得创建投影对象」）。
 */
export function cachedBotAdminStatus(chatId: number): boolean | undefined {
  return getChatState(chatId).botPermissions?.isAdministrator;
}

/**
 * 机器人在某群是否为管理员。身份不再另走一套查询与缓存：直接复用
 * `botChatPermissionsIn` 的完整快照，未知/查询失败时 fail closed 为 false。
 */
export async function resolveBotAdminStatus(chatId: number): Promise<boolean> {
  const permissions: BotChatPermissions | undefined = await botChatPermissionsIn(chatId);
  return permissions?.isAdministrator === true;
}

/**
 * 丢掉某个群的权限位记录，并作废此刻仍在途的那次现查。
 *
 * 在途时删除当前请求令牌与 fetch：旧请求回来后发现令牌已不匹配，不会回填；切换
 * 后的第一次判定也能立即另发新请求，不被已作废的 Telegram 往返阻塞。令牌在调用
 * Telegram 前同步登记，覆盖「请求已发出、fetch Promise 尚未登记」的窄窗口。
 */
export function forgetBotChatPermissions(chatId: number): void {
  const had: boolean = getChatState(chatId).botPermissions !== undefined;
  clearChatStateField(chatId, "botPermissions");
  botPermissionProbeBackoff.delete(chatId);
  botPermissionRequestTokens.delete(chatId);
  botPermissionFetches.delete(chatId);
  // 下面两件事都只在真的丢掉了一份已知值时做：teardown 路径会对同一个群反复调用，
  // 无条件执行就是白写一次盘、再往 Worker mailbox 里灌一条重复消息。
  if (!had) return;
  // 落盘不能省。botPermissions 现在是持久字段：只清 LRU 的话，内存说「未知」而
  // SQLite 还留着刚被判定为陈旧的那份快照。多数调用点后面跟着 persistChatState
  // （离群、/init 两条路），唯独 markBotAdminObserved 那条不是——它 forget 之后
  // 现查，而 getChatMember 失败时按约定什么都不记，这一轮就这么带着分歧结束。
  // 重启后 hydrateChatStateCache 把旧快照读回来，因为「!== undefined」，
  // ensureBotChatPermissions 直接早退、resolveBotAdminStatus 恒为 false，/block 与
  // 各处 managed 群清扫都会跳过这个群，尽管机器人在那儿是好好的管理员。
  //
  // 用后台写而不是 persistChatState：这个函数会被 teardown 路径反复调用，不该在
  // 那里插一道 flush barrier；而「未知」这个值写晚了最多多现查一次，不是
  // durability 事故。
  saveChatStateInBackground(chatId, "bot permissions forgotten");
  notifyBotPermissionObserver(chatId, undefined);
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
 * 已知（State 快照命中）或已有现查在途时立即返回，因此稳定状态下就是一次 Map 查找。
 * 只有从未观测过的群才在后台现查一次，结果经上面的广播抵达 Worker。**必须带
 * 退避**：`getChatMember` 持续失败时，`botChatPermissionsIn` 按约定不落快照，
 * 没有退避就等于那种群里每条消息
 * 都换一次注定失败的现查。
 */
export function ensureBotChatPermissions(chatId: number, now?: number): void {
  if (getChatState(chatId).botPermissions !== undefined || botPermissionRequestTokens.has(chatId)) return;
  if (!admitBotPermissionProbe(chatId, now)) return;
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
  return getChatState(chatId).botPermissions?.canDeleteMessages;
}

/**
 * 机器人在某群持有的完整管理员权限。已记录的群直接同步命中；从未记录过的
 * 群现查一次 getChatMember 并回填（带在途去重，同群并发判定共享同一次请求）。
 *
 * 存在的理由是**先判后打**：踢人、禁言、删消息在缺权限时都只换回一句 400
 * `not enough rights`，而那句话与「目标本身是管理员」共用同一个错误码，事后
 * 看日志分不开（见 infra/telegram/actions.ts 的 banChatMemberWithOutcome）。
 * 有了 State 里的这份唯一快照，绝大多数判定是一次 Map 查找，只有快照缺失的群
 * 才付一次现查——此后由 my_chat_member 近实时维护。
 * @returns 确证的完整权限快照；现查失败或结果已被失效作废时为 undefined。
 *   已确证不是管理员也返回一份全权限 false 快照，不与未知混用。
 *   调用方一律把 undefined 当作「这个动作现在做不了」，不得折算成有权限。
 */
export async function botChatPermissionsIn(chatId: number): Promise<BotChatPermissions | undefined> {
  const known: BotChatPermissions | undefined = getChatState(chatId).botPermissions;
  if (known !== undefined) return known;

  const pending: Promise<BotChatPermissions | undefined> | undefined = botPermissionFetches.get(chatId);
  if (pending !== undefined) return pending;

  // 占位必须早于任何 await：它同时是 forgetBotChatPermissions 判断「有没有
  // 现查在途」的唯一依据，晚一步登记就会漏掉这段窗口里到达的失效。
  const requestToken: symbol = Symbol(`bot-permissions:${chatId}`);
  botPermissionRequestTokens.set(chatId, requestToken);
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
    if (botPermissionRequestTokens.get(chatId) !== requestToken) return undefined;
    // 现查在途期间 my_chat_member 先一步落地过：那条是权威信号，而这次响应
    // 反映的可能是它到达之前的旧快照，直接回填会把刚生效的权限改动顶掉。
    // 同 resolveBotAdminStatus 的「权威信号已经赢了就采用它」。
    const authoritative: BotChatPermissions | undefined = getChatState(chatId).botPermissions;
    if (authoritative !== undefined) return authoritative;
    const permissions: BotChatPermissions = readBotChatPermissions(member);
    // 「没 /init enable 的群不创建 State」这道门禁由 recordBotChatPermissions 首行
    // 独家把守（两处 JSDoc 都称它是唯一门禁）；这里不再重判一次——重判省不掉任何
    // 工作，却多一个将来要跟着一起改的地方。
    // 落盘失败是 fatal durability failure，不得被上面的 Telegram API catch 折算成未知。
    await recordBotChatPermissions(chatId, permissions);
    return permissions;
  })();
  const tracked: Promise<BotChatPermissions | undefined> = request.finally((): void => {
    if (botPermissionFetches.get(chatId) === tracked) botPermissionFetches.delete(chatId);
    if (botPermissionRequestTokens.get(chatId) === requestToken) {
      botPermissionRequestTokens.delete(chatId);
    }
  });
  // getChatMember mock/API 包装可以在第一次 await 前同步触发失效；那种情况下当前
  // 令牌已经换掉，旧请求不得覆盖失效后刚登记的新 fetch。
  if (botPermissionRequestTokens.get(chatId) === requestToken) {
    botPermissionFetches.set(chatId, tracked);
  }
  return tracked;
}
