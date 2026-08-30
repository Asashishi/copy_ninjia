/** Owner: Disk I/O Worker。统一持有每日维护 cron 的进程内句柄。 */

/**
 * 运势、日志、入群日志、广告样本、待验证与临时白名单共用的每日维护 cron。
 *
 * - 填充：启动恢复全部成功后由 `maintenanceCron.ts` 注册并立即 `unref`。
 * - 清理：重复注册或启动恢复重新进入时先停止旧句柄；Worker 终止后随 isolate 销毁。
 * - 重建：新 Worker 在自己的启动恢复成功后重新注册，不跨线程传递句柄。
 * - 容量：单个句柄，无增长与淘汰策略。
 * - `null` 表示当前没有已注册任务，不能据此推断各领域是否完成过维护。
 */
export const diskIOMaintenanceCron: {
  current: Bun.CronJob | null;
} = { current: null };
