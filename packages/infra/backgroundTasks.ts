import { logger } from "./logger";

/**
 * 广告处置、延迟删除与 gag 提示共用的后台任务错误边界。
 * 错误归一化后摘除任务；有界等待由 libs/inflight.ts 负责。
 */

/**
 * 把一条后台任务接入 owner 的在途集合，并在结算后自摘除。
 * @param tasks owner 持有的在途集合；本函数只增删自己登记的那一个条目。
 * @param task 已经启动的任务；异常只记一行日志，绝不逃出本边界。
 * @param failureMessage 失败时那一行日志的完整英文前缀（含冒号）；各 owner 自己
 * 措辞，本函数不替它把可预期的投递失败说成 unexpected。
 */
export function trackBackgroundTask(
  tasks: Set<Promise<void>>,
  task: Promise<unknown>,
  failureMessage: string
): void {
  const observed: Promise<void> = task
    .then((): void => undefined)
    .catch((error: unknown): void => {
      logger.error(failureMessage, error);
    })
    .finally((): void => {
      tasks.delete(observed);
    });
  tasks.add(observed);
}
