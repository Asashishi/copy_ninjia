import { InputFile } from "grammy";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  BOT_PROFILE_PHOTO_FILE_NAME,
} from "../../../consts/telegram";
import { signalArgs } from "../../../libs/telegramSignalArgs";
import { bot } from "../mainClient";

/** 单次头像操作的结果：区分可重试故障与确定性失败。 */
export type AvatarOperationAttemptResult = "ok" | "transient-failure" | "permanent-failure";

/** 有界头像重试的最终结果；`aborted` 表示某次尝试开始前取消信号已经触发。 */
export type AvatarFetchAttemptsOutcome = "ok" | "failed" | "aborted";

/**
 * 按 AVATAR_FETCH_MAX_ATTEMPTS 有界重试一次头像操作，复制目标头像与复原默认
 * 头像两条路径共用。
 *
 * 每次尝试开始前检查取消信号，已取消时返回 `aborted` 且不再调用 `attempt`；
 * `ok` 立即返回，`permanent-failure` 不再重试并返回 `failed`，
 * `transient-failure` 进入下一次，次数用尽后返回 `failed`。逐次失败日志由
 * `attempt` 自己记录。
 * @param attempt 接收从 1 开始的尝试序号。
 */
export async function runAvatarFetchAttempts(
  attempt: (attemptNumber: number) => Promise<AvatarOperationAttemptResult>,
  signal?: AbortSignal
): Promise<AvatarFetchAttemptsOutcome> {
  for (let attemptNumber: number = 1; attemptNumber <= AVATAR_FETCH_MAX_ATTEMPTS; attemptNumber++) {
    if (signal?.aborted) return "aborted";
    const result: AvatarOperationAttemptResult = await attempt(attemptNumber);
    if (result === "ok") return "ok";
    if (result === "permanent-failure") return "failed";
  }
  return "failed";
}

/**
 * 把一段图片字节换成机器人头像。三条头像路径（复制目标头像、t.me 页面兜底、
 * 复原默认头像）唯一的上传出口。
 *
 * 只负责这一次 Bot API 调用：**不 catch**。三个调用点对失败的归类各不相同
 * （可重试 / 确定性失败 / 直接放弃），异常一律原样上抛由它们自己判。
 * 文件名固定为 BOT_PROFILE_PHOTO_FILE_NAME，取消信号照常下传。
 */
export async function setBotProfilePhoto(
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  await bot.api.setMyProfilePhoto(
    { type: "static", photo: new InputFile(bytes, BOT_PROFILE_PHOTO_FILE_NAME) },
    ...signalArgs(signal)
  );
}
