/** owner: workers/antiRaid。机器人自身权限位的 Worker 侧镜像（packages/workers/antiRaid/botPermissions.ts）。 */

import type { BotActionPermissions } from "../../../types/telegram";

/**
 * 机器人在各群持有的破坏性动作权限位，由主线程按变更镜像过来。
 *
 * 权威副本是主线程 `ChatState.botPermissions`；本表是执行侧的只读投影，
 * 踢人、禁言、删消息的请求发出前在本线程读取。推送时机：主线程每次确证或作废权限时
 * 发一条 `botPermissionsChanged`，按群增量覆盖。
 *
 * 「无条目」表示此刻未知，不表示「做不了」。离群、`/init` 切换和
 * 主动失效会删掉条目；撤管理员则镜像一份确证的全 false 投影；首次现查失败同样不写入条目。
 * 本表保留「未知 / 确证 false / 确证权限位」三态，未知档由调用方各自决定：现有读口一律是
 * 「确证 false 才放弃，未知照常发请求」（见 workers/antiRaid/botPermissions.ts 的两个读口，
 * 以及 floodControl.ts / adDetect/disposal.ts / verificationEffects/kick.ts、terminal.ts 的用法）。
 * 新增读口沿用同一口径，不得把 undefined 与 false 压成一个布尔。
 *
 * 条目数与 State 权威快照同阶（只有 `/init enable` 且确证过权限的群才有）。重放方：
 * Worker 重建与进程启动时主线程整表重放（packages/antiRaid/workerBridge/replay.ts），
 * 本线程不自行恢复；`deactivateChat` 与 Worker stop 时清除。
 */
export const workerBotChatPermissions: Map<number, BotActionPermissions> = new Map();
