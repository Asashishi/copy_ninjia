import {
  RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
  RUNNER_DRAIN_POLL_INTERVAL_MS,
  RUNNER_DRAIN_TIMEOUT_MS,
} from "../../consts/lifecycle";
import {
  createMonotonicDeadline,
  isMonotonicDeadlineExpired,
} from "../../libs/monotonicDeadline";
import type { AcknowledgedUpdateRunner } from "../../types/lifecycle";
import type { ApplicationLifecycleDependencies } from "../lifecycleDependencies";

/** 依次关闭所有会在停机排空期间继续制造工作的维护 owner。 */
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
  // 每个入口独立结算：前一个 owner 抛错不能让后续入口继续接受新工作。
  quiesceOwner("avatar", (): void => dependencies.quiesceAvatarUpdates());
  quiesceOwner("chat-title", (): void => dependencies.quiesceChatTitleRefresh());
  quiesceOwner("translate", (): void => dependencies.quiesceTranslate());
  quiesceOwner("gag", (): void => dependencies.quiesceGagRuntime());
  quiesceOwner("wed", (): void => dependencies.quiesceWedRuntime());
  // 补扫 timer 能启动 Anti-Raid 网络任务与 outbox 写入，必须在确认最终 offset
  // 前与其它 maintenance owner 一起关闸；只在 dispose() 终局关会在前置 drain
  // 已完成后重新制造工作，破坏“排空后不再有生产者”的边界。
  quiesceOwner("blocklist-sweep", (): void =>
    dependencies.quiesceBlocklistSweepScheduler());
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

/** 等待已启动的群标题维护任务；预算耗尽时先取消任务，再向停机门禁报告失败。 */
export async function waitForLifecycleBackgroundMaintenance(
  task: Promise<void>,
  timeoutMs: number,
  dependencies: ApplicationLifecycleDependencies
): Promise<boolean> {
  if (timeoutMs <= 0) {
    // 没有等待窗口时也必须 abort：不变量要求预算耗尽后不得再写入群标题。
    dependencies.abortChatTitleRefresh();
    dependencies.logger.error("Skipping unfinished chat title refresh during emergency disposal; aborted it.");
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled: boolean = await Promise.race([
    task.then((): boolean => true),
    new Promise<boolean>((resolve: (value: boolean | PromiseLike<boolean>) => void): void => {
      timer = setTimeout((): void => resolve(false), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!settled) {
    dependencies.abortChatTitleRefresh();
    dependencies.logger.error(`Chat title refresh did not settle within ${timeoutMs}ms and was aborted.`);
  }
  return settled;
}
