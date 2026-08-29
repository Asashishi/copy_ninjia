import type { BotChatPermissions } from "../../types/telegram";

/**
 * 机器人自身权限现查的主线程短期协调状态。
 *
 * 权限值本身不在这里再存一份；主线程唯一快照是
 * `packages/cache/main/storage.ts` 持有的 `ChatState.botPermissions`。本文件只保留
 * 在途请求、失效标记、失败退避与 Worker 观察者槽位，它们都不是业务快照。
 * 进程重启后全部恢复为空，由后续现查与 Worker 注册重新建立。
 */

/** 进行中的权限现查，按 chatId 去重：同群并发判定共享同一次 getChatMember。 */
export const botPermissionFetches: Map<number, Promise<BotChatPermissions | undefined>> = new Map();

/**
 * 当前有效权限现查的身份令牌；失效时删除令牌与 fetch，使切换后的新判定可立即重查。
 *
 * 旧请求即使晚到，也必须先核对自己的 symbol 仍是当前值才能回填 State；新请求因此
 * 不必等待已作废的 Telegram 往返结算。条目只存在于请求在途期间，settle 时清理。
 */
export const botPermissionRequestTokens: Map<number, symbol> = new Map();

/**
 * 按需补齐权限位失败后的退避时刻（ms），按 `BOT_PERMISSION_PROBE_RETRY_MS`。
 *
 * 只在没能确证权限位时写入，确证成功即删除（此后走缓存命中，不再有人问）。
 * 容量与「当前正处于退化状态的群数」同阶；`/init` 切换与停管一并清除。
 */
export const botPermissionProbeBackoff: Map<number, number> = new Map();

/**
 * 权限位变更的下游观察者单槽位，由 `packages/antiRaid/workerBridge.ts` 反向注册
 * （同 `packages/cache/main/blocklist.ts` 的处置 owner 槽位）。
 *
 * infra 不得静态依赖 Anti-Raid 业务模块（见 docs/cn/04-invariants.md），而权限位
 * 只有主线程观测得到、执行踢人/禁言/删消息的却是 Anti-Raid Worker，所以变更
 * 经这个槽位广播出去。
 *
 * `permissions` 为 undefined 表示**「此刻未知」，既不是「做不了」也不许沿用旧值**：
 * 离群、`/init` 切换与主动失效会删掉快照并广播 undefined；撤管理员则广播一份
 * 明确的全 false 快照。现查失败不改写已有权威快照，首次现查失败时仍保持未知。
 * 接收侧因此如实保留三态、只在确证 false 时放弃，未知照常发请求让 Telegram 当
 * 裁判。这份契约的权威表述与全部读口清单在
 * `packages/cache/workers/antiRaid/botPermissions.ts`（AGENTS.md 的镜像范例），
 * 两处不得各写一份。
 *
 * 与主线程自己那个读口（`botChatPermissionsIn` 的返回值：undefined 一律按「这个
 * 动作现在做不了」办）口径不同，是有意的分工，见 docs/cn/04-invariants.md：那边是
 * 就地要动手的调用方，保守到底；这条广播只负责如实转述观测到了什么。
 */
export const botPermissionObserver: {
  current: ((chatId: number, permissions: BotChatPermissions | undefined) => void) | null;
} = { current: null };
