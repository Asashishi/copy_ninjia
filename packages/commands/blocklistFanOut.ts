/**
 * `/block enable` 的跨群封禁扇出（commands/block.ts）。
 *
 * handler 完成权限与目标校验、名单写入与落盘确认后，把扇出连同战报交给延迟命令执行器
 * （./deferredCommands.ts）的 background 档，update runner 不等各群的 Telegram 请求。
 * 提交前先按命令到达顺序在同一身份的黑名单串行区（cache/main/blocklist.ts 的
 * blocklistIdentityMutationRunner）占位，扇出轮到串行位后才开始，同一身份先后几条命令与
 * 广告处置按到达顺序落定；执行器满额或已停止接纳时就地执行，也排在仍在执行器里等待的
 * 同身份扇出之后。执行器在任务开跑前撤销时释放串行位。停机取消或崩溃时尚未处置的群由
 * 启动后的全名单补扫按名单封禁，战报不补发；`/block disable` 在自己的 update 内完成
 * （commands/unblock.ts）。
 */

import { blocklistIdentityMutationRunner } from "../cache/main/blocklist";
import { submitDeferredCommand } from "./deferredCommands";

/** runBlocklistFanOut 的入参。 */
export interface RunBlocklistFanOutParams {
  /** 被拉黑的身份；扇出在它的黑名单串行区里执行。 */
  readonly identityId: number;
  /** 后台任务意外抛错时写进错误日志的英文前缀。 */
  readonly errorLabel: string;
  /** 逐群封禁并在发起群发战报。 */
  readonly fanOut: () => Promise<void>;
}

/** 占好串行位后提交扇出；交给执行器时立即返回，执行器拒收时就地等到串行位并执行到结束。 */
export async function runBlocklistFanOut({ identityId, errorLabel, fanOut }: RunBlocklistFanOutParams): Promise<void> {
  const turn: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  const release: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  // 串行位只负责排序；扇出在执行任务里运行，带执行器的停机信号与发起 update 的上下文。
  void blocklistIdentityMutationRunner.run(identityId, (): Promise<void> => {
    turn.resolve();
    return release.promise;
  });
  const task = async (): Promise<void> => {
    await turn.promise;
    try {
      await fanOut();
    } finally {
      release.resolve();
    }
  };
  if (submitDeferredCommand({
    priority: "background",
    task,
    errorLabel,
    onSkipped: (): void => { release.resolve(); },
  })) return;
  await task();
}
