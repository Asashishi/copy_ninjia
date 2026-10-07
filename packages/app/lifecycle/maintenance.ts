import {
  RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
  RUNNER_DRAIN_POLL_INTERVAL_MS,
  RUNNER_DRAIN_TIMEOUT_MS,
} from "../../consts/lifecycle";
import { settleWithinBudget } from "../../libs/inflight";
import {
  createMonotonicDeadline,
  isMonotonicDeadlineExpired,
} from "../../libs/monotonicDeadline";
import type { AcknowledgedUpdateRunner } from "../../types/lifecycle";
import type { ApplicationLifecycleDependencies } from "../lifecycleDependencies";

/**
 * 依次关闭所有会在停机排空期间继续制造工作的维护 owner。
 *
 * 每次调用都完整执行全部入口（均为幂等赋值）；app/lifecycle.ts 的 init() 会把各 owner 的
 * 接纳重新置真。
 * @returns 全部入口都未抛错时为 true。
 */
export function quiesceLifecycleMaintenance(
  dependencies: ApplicationLifecycleDependencies
): boolean {
  let succeeded: boolean = true;
  const quiesceOwner = (owner: string, run: () => void): void => {
    try {
      run();
    } catch (error: unknown) {
      succeeded = false;
      dependencies.logger.error(`Shutdown owner ${owner} quiesce threw during shutdown:`, error);
    }
  };
  // 每个入口独立结算：前一个 owner 抛错不影响后续入口。
  quiesceOwner("avatar", (): void => dependencies.quiesceAvatarUpdates());
  quiesceOwner("chat-title", (): void => dependencies.quiesceChatTitleRefresh());
  quiesceOwner("translate", (): void => dependencies.quiesceTranslate());
  quiesceOwner("gag", (): void => dependencies.quiesceGagRuntime());
  quiesceOwner("wed", (): void => dependencies.quiesceWedRuntime());
  quiesceOwner("deferred-commands", (): void => dependencies.quiesceDeferredCommandRuntime());
  // 定时任务会在排空期间继续触发发送，与其它发送方一起在排空前关闸。
  quiesceOwner("cron", (): void => dependencies.quiesceCronScheduler());
  // 补扫 timer 能启动 Anti-Raid 网络任务与 outbox 写入，在确认最终 offset
  // 前与其它 maintenance owner 一起关闸，排空之后不再有生产者。
  quiesceOwner("blocklist-sweep", (): void =>
    dependencies.quiesceBlocklistSweepScheduler());
  // 配置热重载会向两条业务 Worker 投递新快照并启动贴纸目录对账，同样在排空前关闸。
  quiesceOwner("config-reload", (): void => dependencies.quiesceConfigReload());
  return succeeded;
}

/**
 * 在正常预算内等待 runner 排空；超时后取消在途 update，并区分取消是否真正结算。
 */
export async function drainAcknowledgedUpdateRunner(
  runner: AcknowledgedUpdateRunner,
  dependencies: ApplicationLifecycleDependencies,
  timeoutMs: number = RUNNER_DRAIN_TIMEOUT_MS
): Promise<"drained" | "aborted" | "unsettled"> {
  const deadline: number = createMonotonicDeadline(
    timeoutMs,
    dependencies.monotonicNow
  );
  while (
    runner.size() > 0 &&
    !isMonotonicDeadlineExpired(deadline, dependencies.monotonicNow)
  ) {
    await dependencies.sleep(RUNNER_DRAIN_POLL_INTERVAL_MS);
  }
  if (runner.size() === 0) return "drained";

  const activeAtDeadline: number = runner.size();
  dependencies.logger.error(
    `Shutdown drain still had ${activeAtDeadline} active update(s) after ${timeoutMs}ms; ` +
    "aborting them and withholding their Telegram offset."
  );
  runner.abortActive();
  const cancellationDeadline: number = createMonotonicDeadline(
    RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
    dependencies.monotonicNow
  );
  while (
    runner.size() > 0 &&
    !isMonotonicDeadlineExpired(
      cancellationDeadline,
      dependencies.monotonicNow
    )
  ) {
    await dependencies.sleep(RUNNER_DRAIN_POLL_INTERVAL_MS);
  }
  if (runner.size() === 0) return "aborted";

  dependencies.logger.error(
    `${runner.size()} update(s) ignored shutdown cancellation for ` +
    `${RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS}ms; forcing a failed process exit after best-effort flush.`
  );
  return "unsettled";
}

/**
 * 等待已启动的群标题维护任务；预算耗尽时先取消任务，再向停机门禁报告失败。
 * task 由 app/lifecycle.ts 在启动时接上 catch，结算即视为完成。
 */
export async function waitForLifecycleBackgroundMaintenance(
  task: Promise<void>,
  timeoutMs: number,
  dependencies: ApplicationLifecycleDependencies
): Promise<boolean> {
  if (timeoutMs <= 0) {
    // 没有等待窗口时同样 abort，预算耗尽后不再写入群标题。
    dependencies.abortChatTitleRefresh();
    dependencies.logger.error("Skipping unfinished chat title refresh during emergency disposal; aborted it.");
    return false;
  }
  const settled: boolean = await settleWithinBudget([task], timeoutMs);
  if (!settled) {
    dependencies.abortChatTitleRefresh();
    dependencies.logger.error(`Chat title refresh did not settle within ${timeoutMs}ms and was aborted.`);
  }
  return settled;
}
