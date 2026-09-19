import type { CronConfig, CronRuntime } from "../../types/cron";

/**
 * Owner: 主线程。cron.json 的已生效任务表（packages/config/cron.ts）。
 *
 * 启动总闸在文件存在时填充；config/ 热重载每轮整体替换，文件被删除时置 null（等价于
 * 空表）。只整体替换、不就地改写；容量由 CRON_MAX_TASKS 与 CRON_MAX_ACTIONS_PER_TASK
 * 限定。不跨线程，Worker 崩溃不影响；进程重启从 null 重新填充。
 */
export const cronConfigCache: { current: CronConfig | null } = { current: null };

/**
 * Owner: 主线程。cron 调度器的运行时（packages/cron/scheduler.ts）。
 *
 * 启动时由 startCronScheduler 创建并按任务表登记调度；热重载按任务名对账：未变的
 * 任务保留句柄，变更或删除的任务停止调度并撤销，新增的任务登记。每个调度持有一个
 * Bun 原生 cron 句柄或一个 rand_cron 随机 timer，全部 unref；在途轮次登记到 runs，
 * 结算自摘除。just_once 执行记录放在有界 LRU（上限 CRON_JUST_ONCE_RECORD_MAX），当前
 * 任务表里的名字每轮对账刷新，淘汰只落在早已删除的旧名字上。停机先 quiesce（停止
 * 接纳、停掉全部句柄与 timer），再在预算内排空在途轮次，超时取消。调度数不超过
 * CRON_MAX_TASKS；Worker 崩溃不影响，进程重启从 null 重新创建，执行记录归零。
 */
export const cronRuntime: { current: CronRuntime | null } = { current: null };
