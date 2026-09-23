import type { BotActionPermissions } from "../../../types/telegram";

/** 机器人自身权限位的 Worker 侧镜像（packages/workers/antiRaid/botPermissions.ts）。 */

/**
 * 机器人在各群持有的破坏性动作权限位，由主线程按变更镜像过来。
 *
 * 权威副本是主线程 `ChatState.botPermissions`；主线程是唯一能观测
 * `my_chat_member` 并写入 State 的地方。这里只是执行侧的只读投影：踢人、禁言、
 * 删消息都在本线程发请求，发之前得先知道做不做得成。
 *
 * **「没有条目」表示「此刻不知道」，不表示「做不了」。** 离群、`/init` 切换和
 * 主动失效会删掉条目；撤管理员则镜像一份确证的全 false 投影；首次现查失败（如
 * 429）同样不写入条目。本表如实保留「未知 / 确证 false / 确证权限位」三态，未知
 * 档由调用方各自决定：现有读口一律是「确证 false 才放弃，未知照常发请求、让
 * Telegram 当裁判」（见 workers/antiRaid/botPermissions.ts 的两个读口，以及
 * floodControl.ts / adDetect/disposal.ts / verificationEffects.ts 的用法）。
 * 新增读口必须沿用同一档口径，不得把 undefined 与 false 压成一个布尔。
 *
 * 条目数与 State 权威快照同阶（只有 `/init enable` 且确证过权限的群才有）。Worker
 * 重建与进程启动时由主线程整表重放，因此这里不需要自己的恢复逻辑；
 * `deactivateChat` 与 Worker stop 时清除。
 */
export const workerBotChatPermissions: Map<number, BotActionPermissions> = new Map();
