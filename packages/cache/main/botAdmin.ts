import type { BotChatPermissions } from "../../types/telegram";

/** 机器人自身管理员身份查询（packages/infra/botAdmin.ts）的内存状态。 */

/**
 * 机器人在各群持有的破坏性动作权限位，纯内存、不落盘。
 *
 * 只记 `/init enable` 过的群，条目数因此与 state.json 的群数同阶。维护路径与
 * 管理员身份记录同源（见 packages/infra/botAdmin.ts 顶部注释的三条路径），但
 * 只有真的看到过一份 ChatMember 的那两条能填：my_chat_member 更新（机器人被
 * 任免、或管理员改了它的权限开关时 Telegram 必发）与按需 getChatMember 现查。
 * 收到别人的 chat_member 更新那一路只推得出「我是管理员」、推不出权限位，
 * 因此不写这张表——「没观测到」必须与「观测到没有」保持可区分。
 *
 * 撤管理员、被移出群聊、`/init` 开关切换都会删掉对应条目，下次需要时重新现查；
 * 进程重启后整表为空，同样按需重建。
 */
export const botChatPermissions: Map<number, BotChatPermissions> = new Map();

/** 进行中的权限现查，按 chatId 去重：同群并发判定共享同一次 getChatMember。 */
export const botPermissionFetches: Map<number, Promise<BotChatPermissions | undefined>> = new Map();

/**
 * 在途权限现查的作废标记：`false` 表示这次现查仍然有效，`true` 表示它发出后
 * 权限已被失效、结果不许回填。
 *
 * 条目的**存在与否**同时是「这个群有没有现查在途」的唯一依据：现查在发请求
 * 之前同步占位、settle 时连同 fetch 记录一起删除，因此这张表只随在途请求增长。
 *
 * 与同文件 `botAdminGenerations` 的单调代际不同，这里只需要布尔——同群的并发
 * 现查由 `botPermissionFetches` 合并成一次，任一时刻至多一次在途，「作废过几次」
 * 没有读者。写成计数器会让人误以为这里防的是 ABA，进而照着给它补引用计数，
 * 或者反过来按它去简化 `botAdminGenerations`（那边的代际是真在用的）。
 */
export const botPermissionInvalidations: Map<number, boolean> = new Map();

/**
 * 按需补齐权限位失败后的退避时刻（ms），按 `BOT_PERMISSION_PROBE_RETRY_MS`。
 *
 * 只在没能确证权限位时写入，确证成功即删除（此后走缓存命中，不再有人问）。
 * 容量与「当前正处于退化状态的群数」同阶；`/init` 切换与停管一并清除。
 */
export const botPermissionProbeBackoff: Map<number, number> = new Map();

/**
 * 权限位变更的下游观察者单槽位，由 `packages/antiRaid/index.ts` 反向注册
 * （同 `packages/cache/main/blocklist.ts` 的处置 owner 槽位）。
 *
 * infra 不得静态依赖 Anti-Raid 业务模块（见 docs/04-invariants.md），而权限位
 * 只有主线程观测得到、执行踢人/禁言/删消息的却是 Anti-Raid Worker，所以变更
 * 经这个槽位广播出去。
 *
 * `permissions` 为 undefined 表示**「此刻未知」，既不是「做不了」也不许沿用旧值**：
 * 撤管理员、离群、`/init` 切换、按需现查失败这四件事发的都是同一条 undefined，
 * 而只有前三件断定得了做不了——现查撞上一次 429 就退避几分钟，那什么也证明不了。
 * 接收侧因此如实保留三态、只在确证 false 时放弃，未知照常发请求让 Telegram 当
 * 裁判。这份契约的权威表述与全部读口清单在
 * `packages/cache/workers/antiRaid/botPermissions.ts`（AGENTS.md 的镜像范例），
 * 两处不得各写一份。
 *
 * 与主线程自己那个读口（`botChatPermissionsIn` 的返回值：undefined 一律按「这个
 * 动作现在做不了」办）口径不同，是有意的分工，见 docs/04-invariants.md：那边是
 * 就地要动手的调用方，保守到底；这条广播只负责如实转述观测到了什么。
 */
export const botPermissionObserver: {
  current: ((chatId: number, permissions: BotChatPermissions | undefined) => void) | null;
} = { current: null };

/** 进行中的 getChatMember 现查，按 chatId 去重：同群并发的未知身份查询共享同一次请求。 */
export const botAdminFetches: Map<number, Promise<boolean>> = new Map();

/** 每次 /init 切换都提升一代，使切换前已发出的查询结果不能回填新一代。 */
export const botAdminGenerations: Map<number, number> = new Map();

/**
 * 每群尚未 settle 的管理员身份查询数。发起查询时递增、finally 递减，
 * 归零后连同 generation 删除；进程重启后不恢复，容量受在途请求群数约束。
 */
export const botAdminGenerationUsers: Map<number, number> = new Map();
