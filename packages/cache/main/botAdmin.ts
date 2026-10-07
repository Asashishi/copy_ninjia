/** owner: main。机器人自身权限现查的主线程短期协调状态。
 *
 * 权限值本身不在这里再存一份；主线程唯一快照是
 * `packages/cache/main/chatState.ts` 持有的 `ChatState.botPermissions`。本文件只保留
 * 在途请求、失效标记、失败退避与 Worker 观察者槽位，它们都不是业务快照。
 * 进程重启后全部恢复为空，由后续现查与 Worker 注册重新建立。
 */

import type { BotChatPermissions } from "../../types/telegram";

/**
 * 进行中的权限现查，按 chatId 去重：同群并发判定共享同一次 getChatMember。
 * 清理：请求 settle 时按 chatId 删除，身份令牌失效（`/init` 切换、停管、主动
 * invalidate）时连同令牌一起删除。容量：同时在途的群数，上界为受管群数
 * （STATE_MANAGED_CHAT_LIMIT）；不设淘汰。
 */
export const botPermissionFetches: Map<number, Promise<BotChatPermissions | undefined>> = new Map();

/**
 * 当前有效权限现查的身份令牌；失效时删除令牌与 fetch，切换后的新判定立即重查。
 *
 * 请求回填 State 前必须先核对自己的 symbol 仍是当前值。条目只存在于请求在途期间，
 * settle 时清理。容量：与 botPermissionFetches 逐键对齐，同样以受管群数为上界。
 */
export const botPermissionRequestTokens: Map<number, symbol> = new Map();

/**
 * 权限现查的退避截止时刻（ms），窗口长度为 `BOT_PERMISSION_PROBE_RETRY_MS`。
 *
 * `infra/botAdmin.ts` 的 admitBotPermissionProbe 每放行一次现查就先写入，不等现查
 * 结果；已 /init 的群记下确证快照（recordBotChatPermissions）时删除，此后走快照命中；
 * forgetBotChatPermissions（`/init` 切换、离群、作废陈旧快照）同样删除。
 * 过期时间戳在该群下次探测时覆盖，没有后续访问的群保留到权限确证、
 * 主动失效或进程重启。容量与尚无确证快照且曾进入退避的受管群数同阶，
 * 上界为 STATE_MANAGED_CHAT_LIMIT（见 consts/storage.ts）。
 */
export const botPermissionProbeBackoff: Map<number, number> = new Map();

/**
 * 权限位变更的下游观察者单槽位，由 `packages/antiRaid/workerBridge/observers.ts` 反向注册
 * （同 `packages/cache/main/blocklist.ts` 的处置 owner 槽位）。
 *
 * infra 不静态依赖 Anti-Raid 业务模块（见 docs/cn/04-invariants.md），权限位变更经这个槽位
 * 广播给 Anti-Raid Worker。
 *
 * `permissions` 为 undefined 表示「此刻未知」，既不是「做不了」，也不沿用旧值：
 * 离群、`/init` 切换与主动失效会删掉快照并广播 undefined；撤管理员则广播一份
 * 明确的全 false 快照。现查失败不改写已有权威快照，首次现查失败时仍保持未知。
 * 接收侧保留三态，只在确证 false 时放弃，未知照常发请求。契约的权威表述与全部读口清单在
 * `packages/cache/workers/antiRaid/botPermissions.ts`，本处不重复。
 *
 * 主线程自己的读口（`botChatPermissionsIn` 的返回值）把 undefined 一律按「这个动作现在做不了」
 * 处理，与本广播口径不同，见 docs/cn/04-invariants.md。
 */
export const botPermissionObserver: {
  current: ((chatId: number, permissions: BotChatPermissions | undefined) => void) | null;
} = { current: null };
